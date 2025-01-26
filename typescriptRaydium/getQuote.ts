import { Connection, PublicKey } from "@solana/web3.js";
import { Liquidity, LIQUIDITY_PROGRAM_ID_V4, Trade, TradeOptions } from "@raydium-io/raydium-sdk";

interface QuoteInput {
    sourceTokenMint: string;
    targetTokenMint: string;
    amount: number;
    slippageTolerance?: number; // Default to 0.5%
    rpcEndpoint?: string; // Customizable RPC endpoint
    verbose?: boolean; // Enable debug logging
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
        minimumAmount: number;
    };
    fees: {
        tradeFee: number;
        ownerFee: number;
    };
    poolAddresses: string[];
}

async function retryConnection(
    rpcEndpoint: string,
    retries = 3,
    delay = 1000
): Promise<Connection> {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return new Connection(rpcEndpoint, "confirmed");
        } catch (error) {
            if (attempt === retries - 1) {
                throw new Error("Failed to establish a connection after retries.");
            }
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
        verbose = false,
    } = params;

    if (!sourceTokenMint || !targetTokenMint || amount <= 0) {
        throw new Error("Invalid parameters: Token mints must be valid, and amount must be greater than zero.");
    }

    const connection = await retryConnection(rpcEndpoint);

    try {
        const pools = await Liquidity.fetchAllPools({
            connection,
            programId: LIQUIDITY_PROGRAM_ID_V4,
        });

        const relevantPools = pools.filter((pool) => {
            const tokenA = pool.tokenMintA.toBase58();
            const tokenB = pool.tokenMintB.toBase58();
            return (
                (tokenA === sourceTokenMint && tokenB === targetTokenMint) ||
                (tokenA === targetTokenMint && tokenB === sourceTokenMint)
            );
        });

        if (verbose) {
            console.log("Filtered Pools:", relevantPools.map((p) => p.id.toBase58()));
        }

        if (relevantPools.length === 0) {
            throw new Error("No relevant pools found for the specified token pair.");
        }

        const tradePromises = relevantPools.map(async (pool) => {
            const tradeOptions: TradeOptions = {
                connection,
                poolKeys: pool,
                amountIn: amount,
                slippage: slippageTolerance / 100,
            };
            return {
                pool,
                quote: await Liquidity.computeTrade(tradeOptions),
            };
        });

        const trades = await Promise.all(tradePromises);

        const bestTrade = trades.reduce((best, current) =>
            !best || (current.quote.estimatedAmountOut > best.quote.estimatedAmountOut) ? current : best
        );

        if (!bestTrade || !bestTrade.quote) {
            throw new Error("No valid trade quote found.");
        }

        const bestPool = bestTrade.pool;
        const bestQuote = bestTrade.quote;

        const tradeFee = parseFloat(
            ((bestPool.tradeFeeNumerator / bestPool.tradeFeeDenominator) * amount).toFixed(bestPool.tokenMintADecimals)
        );
        const ownerFee = parseFloat(
            ((bestPool.ownerFeeNumerator / bestPool.ownerFeeDenominator) * amount).toFixed(bestPool.tokenMintADecimals)
        );

        return {
            inputToken: {
                mint: sourceTokenMint,
                decimals: bestPool.tokenMintADecimals,
                amount,
            },
            outputToken: {
                mint: targetTokenMint,
                decimals: bestPool.tokenMintBDecimals,
                estimatedAmount: parseFloat(
                    bestQuote.estimatedAmountOut.toFixed(bestPool.tokenMintBDecimals)
                ),
                minimumAmount: parseFloat(
                    bestQuote.minimumAmountOut.toFixed(bestPool.tokenMintBDecimals)
                ),
            },
            fees: {
                tradeFee,
                ownerFee,
            },
            poolAddresses: [bestPool.id.toBase58()],
        };
    } catch (error) {
        throw new Error(`Error during quote computation: ${error.message}`);
    }
}

(async () => {
    try {
        const quote = await getQuote({
            sourceTokenMint: "SOL_MINT_ADDR",
            targetTokenMint: "EXAMPLE_USDC_MINT_ADDR",
            amount: 1_000_000,
            verbose: true,
        });

        console.log("Detailed Swap Quote:", JSON.stringify(quote, null, 2));
    } catch (error) {
        console.error("Error:", error.message);
    }
})();
