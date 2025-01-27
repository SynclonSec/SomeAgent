import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { LiquidityPoolKeys } from "@raydium-io/raydium-sdk";

export interface TokenMetadata {
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
}

export interface QuoteInput {
    sourceTokenMint: string;
    targetTokenMint: string;
    amount: number;
    slippageTolerance?: number;
    rpcEndpoint?: string;
    verbose?: boolean;
}

export interface QuoteOutput {
    inputToken: TokenAmount;
    outputToken: TokenAmountWithMinimum;
    fees: SwapFees;
    poolAddresses: string[];
}

export interface SwapParams {
    sourceTokenMint: string;
    targetTokenMint: string;
    amountInBaseUnits: number;
    slippageTolerance: number;
    userPublicKey: PublicKey;
    rpcEndpoint?: string;
}

export interface SwapInstructions {
    transactionVersion: 'legacy' | 'v0';
    serializedTransaction: string;
    signers: PublicKey[];
    recentBlockhash: string;
    computeUnits: number;
}

export interface SwapResponse {
    status: "success" | "error";
    swapInstructions?: SwapInstructions;
    error?: string;
    metadata?: SwapMetadata;
}

// Base types
interface TokenAmount {
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    amount: number;
    amountInBaseUnits: number;
}

interface TokenAmountWithMinimum extends TokenAmount {
    minimumAmount: number;
    minimumAmountInBaseUnits: number;
}

interface SwapFees {
    tradeFee: number;
    ownerFee: number;
    tradeFeeInBaseUnits: number;
    ownerFeeInBaseUnits: number;
}

interface SwapMetadata {
    quoteId: string;
    preparedAt: number;
    expiresAt: number;
}

export type PoolFilterCriteria = {
    minReserve?: number;
    maxReserve?: number;
    allowedMints?: string[];
};
