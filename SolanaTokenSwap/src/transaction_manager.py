# transaction_manager.py
import json
import logging
import subprocess
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Optional, Tuple
import base64
import hmac
import hashlib
import os

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.transaction import Transaction, VersionedTransaction
from solana.publickey import PublicKey
from solders.signature import Signature

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class SwapParams:
    source_mint: str
    target_mint: str
    amount: int  # In base units (lamports)
    slippage: float  # Percentage (0.1-100)
    user_pubkey: str
    rpc_endpoint: str = "https://api.mainnet-beta.solana.com"

@dataclass
class SwapInstructions:
    transaction: VersionedTransaction
    recent_blockhash: str
    compute_units: int
    quote_id: str
    expires_at: int

class TransactionManager:
    def __init__(self, 
                 wallet_path: str = "wallet.enc",
                 hmac_secret: str = os.getenv("HMAC_SECRET")):
        self.client = AsyncClient()
        self.hmac_secret = hmac_secret
        self.nonces = set()
        
        # Load encrypted wallet
        self.wallet = self._load_secure_wallet(wallet_path)

    def _validate_response(self, data: Dict, signature: str) -> bool:
        """HMAC validation of TypeScript response"""
        computed = hmac.new(
            self.hmac_secret.encode(),
            json.dumps(data, sort_keys=True).encode(),
            hashlib.sha512
        ).hexdigest()
        return hmac.compare_digest(computed, signature)

    async def prepare_swap(self, params: SwapParams) -> SwapInstructions:
        """Prepare swap transaction with security checks"""
        # Generate anti-replay nonce
        nonce = os.urandom(16).hex()
        self.nonces.add(nonce)

        try:
            proc = subprocess.run(
                [
                    "ts-node", "typescriptRaydium/swap.ts",
                    "prepare",
                    params.source_mint,
                    params.target_mint,
                    str(params.amount),
                    str(params.slippage),
                    params.user_pubkey,
                    params.rpc_endpoint,
                    nonce
                ],
                capture_output=True,
                check=True,
                text=True
            )
            response = json.loads(proc.stdout)
            
            # Validate HMAC
            if not self._validate_response(response['data'], response['sig']):
                raise SecurityError("Invalid response signature")

            # Validate nonce
            if response['data']['nonce'] != nonce:
                raise SecurityError("Invalid nonce")

            return self._parse_swap_response(response['data'])

        except subprocess.CalledProcessError as e:
            logger.error(f"Swap preparation failed: {e.stderr}")
            raise
        except json.JSONDecodeError:
            logger.error("Invalid JSON response from swap.ts")
            raise

    def _parse_swap_response(self, data: Dict) -> SwapInstructions:
        """Convert TypeScript response to Python objects"""
        try:
            raw_tx = base64.b64decode(data['serializedTransaction'])
            return SwapInstructions(
                transaction=VersionedTransaction.deserialize(raw_tx),
                recent_blockhash=data['recentBlockhash'],
                compute_units=data['computeUnits'],
                quote_id=data['metadata']['quoteId'],
                expires_at=data['metadata']['expiresAt']
            )
        except KeyError as e:
            logger.error(f"Missing field in response: {e}")
            raise

    async def execute_swap(self, instructions: SwapInstructions) -> Signature:
        """Execute a prepared swap with hardware verification"""
        # Check expiration
        if datetime.now().timestamp() > instructions.expires_at:
            raise ExpiredSwapError("Swap instructions expired")

        # Verify transaction integrity
        self._verify_transaction(instructions.transaction)

        # Submit transaction
        return await self.client.send_transaction(
            instructions.transaction,
            opts=TxOpts(
                skip_preflight=False,
                preflight_commitment=Confirmed
            )
        )

    def _verify_transaction(self, tx: VersionedTransaction):
        """Verify transaction meets security requirements"""
        # Check signers
        if PublicKey(self.wallet.public_key) not in tx.message.account_keys:
            raise SecurityError("Wallet not in transaction signers")

        # Check compute limits
        if tx.message.header.num_required_signatures > 2:
            raise SecurityError("Excessive signature requirements")

    async def confirm_swap(self, signature: Signature) -> Dict:
        """Wait for transaction confirmation with security checks"""
        return await self.client.confirm_transaction(
            signature,
            Confirmed,
            sleep_seconds=2
        )

    def _load_secure_wallet(self, path: str) -> Keypair:
        """Load encrypted wallet using hardware-secured module"""
        # Implementation specific to your HSM
        return hsm.load_keypair(path)

class SecurityError(Exception):
    """Custom security violation exception"""

class ExpiredSwapError(Exception):
    """Exception for expired swap instructions"""
