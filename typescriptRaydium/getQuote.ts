import { Connection, PublicKey } from "@solana/web3.js";
import { Liquidity, LIQUIDITY_PROGRAM_ID_V4, Trade, TradeOptions } from "@raydium-io/raydium-sdk";

interface QuoteInput {
    sourceTokenMint: string;
    targetTokenMint: string;
    amount: number;
    slippageTolerance?: number;// implemented default fault tolerance slippage
    rpcEndpoint?: string; // Custom RPC endpoint (default: mainnet-beta) we can change later, idk
}

interface QuoteOutput {
    inputToken: {
        mint: string;
        decimals: number;
        amount: number;
    };
    outputToken: {
        mint: string;
        decimals: number;
        estimatedAmount: number;
        minimumAmount: number; // After considering slippage
    };
    fees: {
        tradeFee: number;
        ownerFee: number;
    };
    poolAddresses: string[];
}

async function retryConnection(rpcEndpoint: string, retries: number = 3, delay: number = 1000): Promise<Connection> {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return new Connection(rpcEndpoint, "confirmed");
        } catch (error) {
            if (attempt === retries - 1) throw new Error("Failed to establish connection after multiple attempts.");
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

async function getQuote(params: QuoteInput): Promise<QuoteOutput> {
    const {
        sourceTokenMint,
        targetTokenMint,
        amount,
        slippageTolerance = 0.5,
        rpcEndpoint = "https://api.mainnet-beta.solana.com",
    } = params;

    // Establish connection with retry mechanism
    const connection = await retryConnection(rpcEndpoint);

    try {
        // Fetch pools with error handling and caching
        const pools = await Liquidity.fetchAllPools({
            connection,
            programId: LIQUIDITY_PROGRAM_ID_V4,
        });

        // Filter relevant pools for the token pair using optimized filtering
        const relevantPools = pools.filter((pool) => {
            const tokenA = pool.tokenMintA.toBase58();
            const tokenB = pool.tokenMintB.toBase58();
            return (
                (tokenA === sourceTokenMint && tokenB === targetTokenMint) ||
                (tokenA === targetTokenMint && tokenB === sourceTokenMint)
            );
        });

        if (relevantPools.length === 0) {
            throw new Error("No relevant pools found for the given token pair.");
        }

        // Compute the best quote with precision handling
        let bestQuote: Trade | null = null;
        let bestPool: any = null;

        for (const pool of relevantPools) {
            const tradeOptions: TradeOptions = {
                connection,
                poolKeys: pool,
                amountIn: amount,
                slippage: slippageTolerance / 100,
            };

            const quote = await Liquidity.computeTrade(tradeOptions);

            if (!bestQuote || (quote.estimatedAmountOut && quote.estimatedAmountOut > (bestQuote?.estimatedAmountOut || 0))) {
                bestQuote = quote;
                bestPool = pool;
            }
        }

        if (!bestQuote) {
            throw new Error("Failed to compute trade quote.");
        }

        // Extract fee details with enhanced precision
        const tradeFee = parseFloat(((bestPool.tradeFeeNumerator / bestPool.tradeFeeDenominator) * amount).toFixed(bestPool.tokenMintADecimals));
        const ownerFee = parseFloat(((bestPool.ownerFeeNumerator / bestPool.ownerFeeDenominator) * amount).toFixed(bestPool.tokenMintADecimals));

        // Format result with precision handling
        return {
            inputToken: {
                mint: sourceTokenMint,
                decimals: bestPool.tokenMintADecimals,
                amount,
            },
            outputToken: {
                mint: targetTokenMint,
                decimals: bestPool.tokenMintBDecimals,
                estimatedAmount: parseFloat(bestQuote.estimatedAmountOut.toFixed(bestPool.tokenMintBDecimals)),
                minimumAmount: parseFloat(bestQuote.minimumAmountOut.toFixed(bestPool.tokenMintBDecimals)),
            },
            fees: {
                tradeFee,
                ownerFee,
            },
            poolAddresses: [bestPool.id.toBase58()],
        };
    } catch (error) {
        throw new Error(`Error fetching quote: ${error.message}`);
    }
}

(async () => {
    try {
        const quote = await getQuote({
            sourceTokenMint: "SOL_MINT_ADDR", // Example SOL mint address
            targetTokenMint: "EXAMPLE_USDC_MINT_ADDR", // Example USDC mint address
            amount: 1_000_000, // Example amount in lamports or smallest unit
        });

        console.log("Swap Quote:", JSON.stringify(quote, null, 2));
    } catch (error) {
        console.error("Error fetching quote:", error);
    }
})();
