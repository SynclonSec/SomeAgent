import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { fetchRaydiumPools } from "./fetchPools";
import { getQuote, QuoteOutput } from "./getQuote";
import { establishConnectionWithRetry } from "./sharedUtils";

// Shared types for cross-file compatibility
interface SwapParams {
    sourceTokenMint: string;
    targetTokenMint: string;
    amountInBaseUnits: number;
    slippageTolerance: number;
    userPublicKey: string;
    rpcEndpoint?: string;
}

interface SwapInstructions {
    transactionVersion: 'legacy' | 'v0';
    serializedMessage: string;
    signers: string[]; // PDA addresses that need to sign
    additionalAccounts: string[];
    instructionData: {
        programId: string;
        accounts: string[];
        data: string;
    }[];
}

interface SwapResponse {
    status: "success" | "error";
    swapInstructions?: SwapInstructions;
    error?: string;
    metadata?: {
        quoteId: string;
        preparedAt: number;
        expiresAt: number;
    };
}

// Core swap preparation logic with full transaction instructions
export async function prepareSwapTransaction(
    params: SwapParams
): Promise<SwapResponse> {
    const {
        sourceTokenMint,
        targetTokenMint,
        amountInBaseUnits,
        slippageTolerance,
        userPublicKey,
        rpcEndpoint = "https://api.mainnet-beta.solana.com"
    } = params;

    try {
        // 1. Establish validated connection
        const connection = await establishConnectionWithRetry(rpcEndpoint, 3);
        
        // 2. Get optimized quote with transaction data
        const quote = await getQuote({
            sourceTokenMint,
            targetTokenMint,
            amount: amountInBaseUnits,
            slippageTolerance,
            rpcEndpoint,
            includeRawTransaction: true // Ensure quote contains transaction data
        });

        if (!quote.rawTransaction) {
            throw new Error("Missing transaction data in quote response");
        }

        // 3. Parse transaction components
        const tx = VersionedTransaction.deserialize(Buffer.from(quote.rawTransaction.data, 'base64'));
        const blockhash = await connection.getLatestBlockhash();
        
        // 4. Prepare instruction payload
        const swapInstructions: SwapInstructions = {
            transactionVersion: quote.rawTransaction.version,
            serializedMessage: Buffer.from(tx.message.serialize()).toString('base64'),
            signers: Array.from(new Set(
                tx.message.staticAccountKeys
                    .filter(k => !k.equals(userPublicKey)) // Exclude user's own key
                    .map(k => k.toBase58())
            )),
            additionalAccounts: tx.message.getAccountKeys().keySegments().flat().map(k => k.toBase58()),
            instructionData: tx.message.compiledInstructions.map(ix => ({
                programId: tx.message.staticAccountKeys[ix.programIdIndex].toBase58(),
                accounts: ix.accountKeyIndexes.map(i => 
                    tx.message.getAccountKeys().get(i)!.toBase58()
                ),
                data: Buffer.from(ix.data).toString('base64')
            }))
        };

        return {
            status: "success",
            swapInstructions,
            metadata: {
                quoteId: `swap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                preparedAt: Date.now(),
                expiresAt: Date.now() + 60_000 // 1 minute validity
            }
        };

    } catch (error) {
        console.error("Swap Preparation Error:", error);
        return {
            status: "error",
            error: this.sanitizeError(error),
            metadata: {
                quoteId: '',
                preparedAt: Date.now(),
                expiresAt: Date.now()
            }
        };
    }
}

// Transaction submission handler
export async function executeSwap(
    params: SwapParams
): Promise<SwapResponse> {
    try {
        const preparation = await prepareSwapTransaction(params);
        
        if (preparation.status !== "success") {
            throw new Error(preparation.error || "Swap preparation failed");
        }

        // Python integration point
        const pythonPayload = {
            instructions: preparation.swapInstructions,
            publicKey: params.userPublicKey,
            network: params.rpcEndpoint,
            commitment: 'confirmed'
        };

        return {
            status: "success",
            swapInstructions: preparation.swapInstructions,
            metadata: preparation.metadata
        };
        
    } catch (error) {
        console.error("Swap Execution Error:", error);
        return {
            status: "error",
            error: this.sanitizeError(error),
            metadata: {
                quoteId: '',
                preparedAt: Date.now(),
                expiresAt: Date.now()
            }
        };
    }
}

// Security utilities
private sanitizeError(error: any): string {
    const msg = error.message || error.toString();
    return msg.replace(/private key/gi, '*****')
             .replace(/mnemonic/gi, '*****')
             .substring(0, 500);
}
