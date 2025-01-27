import json
import subprocess
from typing import List, Dict, Optional
from dataclasses import dataclass
import heapq

@dataclass
class SwapStep:
    source_mint: str
    target_mint: str
    pool_address: str
    in_amount: float
    out_amount: float
    fees: float

@dataclass
class OptimizedRoute:
    path: List[SwapStep]
    total_input: float
    total_output: float
    total_fees: float
    price_impact: float

class RouteOptimizer:
    def __init__(self, ts_executable: str = "ts-node", rpc_endpoint: str = "https://api.mainnet-beta.solana.com"):
        self.ts_executable = ts_executable
        self.rpc_endpoint = rpc_endpoint
        self.token_registry = self._load_token_registry()
        
    def _load_token_registry(self) -> Dict[str, dict]:
        """Fetch token registry from TypeScript code"""
        result = subprocess.run(
            [self.ts_executable, "-e", "console.log(JSON.stringify(require('./getQuotes').buildTokenMetadataMap()))"],
            capture_output=True,
            text=True
        )
        return json.loads(result.stdout)

    def _get_single_quote(self, source: str, target: str, amount: float) -> Optional[dict]:
        """Execute TypeScript getQuote function and parse result"""
        script = f"""
        const quote = await require('./getQuotes').getQuote({{
            sourceTokenMint: '{source}',
            targetTokenMint: '{target}',
            amount: {amount},
            rpcEndpoint: '{self.rpc_endpoint}'
        }});
        console.log(JSON.stringify(quote));
        """
        
        try:
            result = subprocess.run(
                [self.ts_executable, "-e", script],
                capture_output=True,
                text=True,
                timeout=10
            )
            return json.loads(result.stdout)
        except (subprocess.TimeoutExpired, json.JSONDecodeError):
            return None

    def find_routes(self, 
                   source_mint: str, 
                   target_mint: str, 
                   amount: float, 
                   max_hops: int = 3,
                   max_routes: int = 5,
                   fee_bps_threshold: int = 100) -> List[OptimizedRoute]:
        """
        Find optimal swap routes using modified Dijkstra's algorithm with:
        - Liquidity awareness
        - Fee consideration
        - Slippage estimation
        """
        viable_routes = []
        visited = set()
        heap = []
        
        direct_quote = self._get_single_quote(source_mint, target_mint, amount)
        if direct_quote:
            heapq.heappush(heap, (
                -direct_quote['outputToken']['estimatedAmount'],
                [SwapStep(
                    source_mint=source_mint,
                    target_mint=target_mint,
                    pool_address=direct_quote['poolAddresses'][0],
                    in_amount=amount,
                    out_amount=direct_quote['outputToken']['estimatedAmount'],
                    fees=direct_quote['fees']['tradeFee'] + direct_quote['fees']['ownerFee']
                )]
            ))

        for _ in range(max_hops - 1):
            if not heap:
                break
                
            current_output, current_path = heapq.heappop(heap)
            current_token = current_path[-1].target_mint
            current_amount = current_path[-1].out_amount
            
            if current_token == target_mint:
                viable_routes.append(current_path)
                continue
                
            if current_token in visited:
                continue
                
            visited.add(current_token)
            
            for token in self._get_connected_tokens(current_token):
                quote = self._get_single_quote(current_token, token, current_amount)
                if not quote or quote['fees']['tradeFee'] > fee_bps_threshold:
                    continue
                
                new_path = current_path + [SwapStep(
                    source_mint=current_token,
                    target_mint=token,
                    pool_address=quote['poolAddresses'][0],
                    in_amount=current_amount,
                    out_amount=quote['outputToken']['estimatedAmount'],
                    fees=quote['fees']['tradeFee'] + quote['fees']['ownerFee']
                )]
                
                heapq.heappush(heap, (
                    -quote['outputToken']['estimatedAmount'], 
                    new_path
                ))

        return self._format_routes(viable_routes[:max_routes], amount)

    def _get_connected_tokens(self, mint: str) -> List[str]:
        """Find tokens with direct pools to current mint"""
        script = f"""
        const pools = await require('./getQuotes').fetchRaydiumPools();
        const connected = pools.filter(p => 
            p.baseMint === '{mint}' || p.quoteMint === '{mint}'
        ).map(p => p.baseMint === '{mint}' ? p.quoteMint : p.baseMint);
        console.log(JSON.stringify(connected));
        """
        
        result = subprocess.run(
            [self.ts_executable, "-e", script],
            capture_output=True,
            text=True
        )
        return json.loads(result.stdout)

    def _format_routes(self, paths: List[List[SwapStep]], input_amount: float) -> List[OptimizedRoute]:
        routes = []
        for path in paths:
            total_output = path[-1].out_amount
            total_fees = sum(step.fees for step in path)
            
            routes.append(OptimizedRoute(
                path=path,
                total_input=input_amount,
                total_output=total_output,
                total_fees=total_fees,
                price_impact=self._calculate_price_impact(path)
            ))
            
        return sorted(routes, key=lambda x: x.total_output, reverse=True)

    def _calculate_price_impact(self, path: List[SwapStep]) -> float:
        """Estimate cumulative price impact across multi-hop swaps"""
        impact = 1.0
        for step in path:
            quote = self._get_single_quote(step.source_mint, step.target_mint, step.in_amount)
            if not quote:
                continue
                
            fair_price = quote['outputToken']['estimatedAmount'] / quote['inputToken']['amount']
            actual_price = step.out_amount / step.in_amount
            impact *= (actual_price / fair_price)
            
        return (1 - impact) * 100 

if __name__ == "__main__":
    optimizer = RouteOptimizer()
    routes = optimizer.find_routes(
        source_mint="So11111111111111111111111111111111111111112",  # SOL
        target_mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
        amount=1.0,
        max_hops=3
    )
    
    for i, route in enumerate(routes[:3]):
        print(f"Route #{i+1}")
        print(f"Total Output: {route.total_output:.2f} USDC")
        print(f"Total Fees: {route.total_fees:.4f} SOL")
        print(f"Price Impact: {route.price_impact:.2f}%")
        print("Path:")
        for step in route.path:
            print(f"  {step.source_mint} -> {step.target_mint} via {step.pool_address[:6]}...")
        print("\n")
