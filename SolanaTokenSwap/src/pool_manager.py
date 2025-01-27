# pool_manager.py
import json
import logging
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Deque
from collections import deque, defaultdict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass(frozen=True)
class TokenMetadata:
    mint: str
    symbol: str
    name: str
    decimals: int
    logoURI: Optional[str] = None
    reserve: Optional[str] = None

@dataclass
class PoolInfo:
    poolAddress: str
    tokenA: TokenMetadata
    tokenB: TokenMetadata
    liquidity: Dict[str, str]
    fees: Dict[str, str]
    version: int
    last_updated: datetime = datetime.now()

class PoolManager:
    def __init__(self,
                 cache_ttl: timedelta = timedelta(minutes=15),
                 rpc_rate_limit: timedelta = timedelta(seconds=5),
                 liquidity_window: timedelta = timedelta(hours=24)):
        self.cache_path = Path("pool_cache.json")
        self.cache_ttl = cache_ttl
        self.rpc_rate_limit = rpc_rate_limit
        self.last_rpc_call = datetime.min
        self.pools: List[PoolInfo] = []
        self.liquidity_history = defaultdict(lambda: deque(maxlen=1000))
        self.liquidity_window = liquidity_window

    def _enforce_rate_limit(self):
        """Enforce RPC rate limiting with exponential backoff"""
        elapsed = datetime.now() - self.last_rpc_call
        if elapsed < self.rpc_rate_limit:
            sleep_time = (self.rpc_rate_limit - elapsed).total_seconds()
            logger.info(f"Enforcing rate limit. Sleeping for {sleep_time:.1f}s")
            time.sleep(sleep_time)

    def _execute_typescript_fetcher(self) -> List[PoolInfo]:
        """Execute TypeScript fetchPools.ts with rate limiting"""
        self._enforce_rate_limit()
        try:
            result = subprocess.run(
                ["ts-node", "typescriptRaydium/fetchPools.ts"],
                check=True,
                capture_output=True,
                text=True
            )
            self.last_rpc_call = datetime.now()
            return self._parse_ts_output(result.stdout)
        except subprocess.CalledProcessError as e:
            logger.error(f"TypeScript fetch failed: {e.stderr}")
            raise
        except json.JSONDecodeError:
            logger.error("Failed to parse TypeScript output")
            raise

    def _parse_ts_output(self, output: str) -> List[PoolInfo]:
        try:
            raw_data = json.loads(output)
            return [
                PoolInfo(
                    poolAddress=pool["poolAddress"],
                    tokenA=TokenMetadata(
                        mint=pool["tokenA"]["mint"],
                        symbol=pool["tokenA"]["symbol"],
                        name=pool["tokenA"]["name"],
                        decimals=pool["tokenA"]["decimals"],
                        reserve=pool["tokenA"]["reserve"],
                        logoURI=pool["tokenA"].get("logoURI")
                    ),
                    tokenB=TokenMetadata(
                        mint=pool["tokenB"]["mint"],
                        symbol=pool["tokenB"]["symbol"],
                        name=pool["tokenB"]["name"],
                        decimals=pool["tokenB"]["decimals"],
                        reserve=pool["tokenB"]["reserve"],
                        logoURI=pool["tokenB"].get("logoURI")
                    ),
                    liquidity=pool["liquidity"],
                    fees=pool["fees"],
                    version=pool["version"]
                ) for pool in raw_data
            ]
        except KeyError as e:
            logger.error(f"Missing expected field in TypeScript output: {e}")
            raise

    def _load_cache(self) -> bool:
        """Load cached pools if valid"""
        if not self.cache_path.exists():
            return False

        mtime = datetime.fromtimestamp(self.cache_path.stat().st_mtime)
        if datetime.now() - mtime > self.cache_ttl:
            return False

        try:
            with open(self.cache_path, "r") as f:
                self.pools = [PoolInfo(**pool) for pool in json.load(f)]
            logger.info(f"Loaded {len(self.pools)} pools from cache")
            return True
        except (json.JSONDecodeError, TypeError) as e:
            logger.warning(f"Invalid cache: {e}")
            return False

    def _save_cache(self) -> None:
        """Save current pools to cache"""
        with open(self.cache_path, "w") as f:
            json.dump(
                [{
                    "poolAddress": p.poolAddress,
                    "tokenA": vars(p.tokenA),
                    "tokenB": vars(p.tokenB),
                    "liquidity": p.liquidity,
                    "fees": p.fees,
                    "version": p.version
                } for p in self.pools],
                f,
                indent=2
            )

    def refresh_pools(self, force: bool = False) -> None:
        """Refresh pool data with liquidity tracking"""
        if not force and datetime.now() - self.last_update < self.cache_ttl:
            return

        previous_pools = {p.poolAddress: p for p in self.pools}

        try:
            new_pools = self._execute_typescript_fetcher()
            self._update_liquidity_history(previous_pools, new_pools)
            self.pools = new_pools
            self._save_cache()
            self.last_update = datetime.now()
            logger.info(f"Refreshed {len(self.pools)} pools")
        except Exception as e:
            logger.error(f"Refresh failed: {e}")
            if not self.pools:
                if not self._load_cache():
                    raise RuntimeError("No pool data available")

    def _update_liquidity_history(self, previous: Dict[str, PoolInfo], current: List[PoolInfo]):
        for pool in current:
            hist_entry = {
                'timestamp': datetime.now(),
                'reserveA': float(pool.tokenA.reserve),
                'reserveB': float(pool.tokenB.reserve),
                'liquidity': float(pool.liquidity['totalSupply'])
            }
            self.liquidity_history[pool.poolAddress].append(hist_entry)

            if pool.poolAddress in previous:
                prev = previous[pool.poolAddress]
                hist_entry['change'] = {
                    'reserveA': self._calculate_change(prev.tokenA.reserve, pool.tokenA.reserve),
                    'reserveB': self._calculate_change(prev.tokenB.reserve, pool.tokenB.reserve),
                    'liquidity': self._calculate_change(prev.liquidity['totalSupply'], pool.liquidity['totalSupply'])
                }

    def calculate_price_impact(self, pool: PoolInfo, amount_in: float, token_mint: str) -> float:
        """Calculate price impact for a potential trade"""
        reserve = self._get_reserve(pool, token_mint)
        if reserve == 0:
            return float('inf')
        return (amount_in / (reserve + amount_in)) * 100

    def calculate_depth(self, pool: PoolInfo, depth_percent: float = 1.0) -> Dict[str, float]:
        """Calculate market depth for ±depth_percent price changes"""
        reserveA = float(pool.tokenA.reserve)
        reserveB = float(pool.tokenB.reserve)
        k = reserveA * reserveB

        price = reserveB / reserveA if reserveA > 0 else 0
        upper_price = price * (1 + depth_percent/100)
        lower_price = price * (1 - depth_percent/100)

        return {
            'depth_upper': self._calculate_depth_at_price(k, upper_price),
            'depth_lower': self._calculate_depth_at_price(k, lower_price),
            'current_price': price
        }

    def liquidity_change(self, pool_address: str, window: Optional[timedelta] = None) -> Dict:
        """Calculate liquidity changes over specified window"""
        window = window or self.liquidity_window
        history = self.liquidity_history.get(pool_address, [])

        relevant = [entry for entry in history
                   if datetime.now() - entry['timestamp'] <= window]

        if len(relevant) < 2:
            return {'error': 'Insufficient data'}

        oldest = relevant[0]
        latest = relevant[-1]

        return {
            'reserveA': self._percent_change(oldest['reserveA'], latest['reserveA']),
            'reserveB': self._percent_change(oldest['reserveB'], latest['reserveB']),
            'liquidity': self._percent_change(oldest['liquidity'], latest['liquidity']),
            'time_window': str(window)
        }

    def _get_reserve(self, pool: PoolInfo, token_mint: str) -> float:
        if pool.tokenA.mint == token_mint:
            return float(pool.tokenA.reserve)
        elif pool.tokenB.mint == token_mint:
            return float(pool.tokenB.reserve)
        raise ValueError("Token not found in pool")

    def _calculate_change(self, old: str, new: str) -> Dict:
        old_val = float(old)
        new_val = float(new)
        return {
            'absolute': new_val - old_val,
            'percent': self._percent_change(old_val, new_val)
        }

    @staticmethod
    def _percent_change(old: float, new: float) -> float:
        if old == 0:
            return 0.0 if new == 0 else float('inf')
        return ((new - old) / abs(old)) * 100

    @staticmethod
    def _calculate_depth_at_price(k: float, target_price: float) -> float:
        if target_price <= 0:
            return 0
        new_reserveB = (k * target_price) ** 0.5
        return new_reserveB

    def find_pools(self,
                 base_mint: Optional[str] = None,
                 quote_mint: Optional[str] = None,
                 min_liquidity: float = 0) -> List[PoolInfo]:
        self.refresh_pools()

        return [
            pool for pool in self.pools
            if (not base_mint or pool.tokenA.mint == base_mint or pool.tokenB.mint == base_mint)
            and (not quote_mint or pool.tokenA.mint == quote_mint or pool.tokenB.mint == quote_mint)
            and (float(pool.liquidity["totalSupply"]) >= min_liquidity)
        ]

    def get_token_pairs(self) -> List[Tuple[str, str]]:
        """Get all unique token pairs with normalized ordering"""
        pairs = set()
        for pool in self.pools:
            pair = tuple(sorted([pool.tokenA.mint, pool.tokenB.mint]))
            pairs.add((pair[0], pair[1]))
        return list(pairs)

    def get_pool_by_address(self, address: str) -> Optional[PoolInfo]:
        """Get pool by on-chain address with O(1) lookup"""
        return next((p for p in self.pools if p.poolAddress == address), None)

