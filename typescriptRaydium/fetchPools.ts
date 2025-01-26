import { Connection, PublicKey } from "@solana/web3.js";
import { Liquidity, LIQUIDITY_PROGRAM_ID_V4 } from "@raydium-io/raydium-sdk";

interface PoolInfo {
    poolAddress: string;
    tokenA: {
        mint: string;
        decimals: number;
        reserve: string; 
    };
    tokenB: {
        mint: string;
        decimals: number;
        reserve: string; 
    };
    liquidity: {
        totalSupply: string; 
        openOrdersAddress: string;
        lpMint: string;
    };
    fees: {
        tradeFeePercentage: string;
        ownerFeePercentage: string;
        rawNumerators: {
            tradeFeeNumerator: number;
            tradeFeeDenominator: number;
            ownerFeeNumerator: number;
            ownerFeeDenominator: number;
        };
    };
}

async function fetchRaydiumPools(): Promise<PoolInfo[]> {
    const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";

    const connection = await establishConnectionWithRetry(RPC_ENDPOINT, 3);

    const pools = await Liquidity.fetchAllPools({
        connection,
        programId: LIQUIDITY_PROGRAM_ID_V4,
    });

    // filtering non important pools with 0 reserves..
    const validPools = pools.filter((pool) => pool.tokenAReserve.gt(0) && pool.tokenBReserve.gt(0));

    const poolInfo = validPools.map((pool) => {
        const tradeFeePercentage = (
            (pool.tradeFeeNumerator / pool.tradeFeeDenominator) * 100
        ).toFixed(2);
        const ownerFeePercentage = (
            (pool.ownerFeeNumerator / pool.ownerFeeDenominator) * 100
        ).toFixed(2);

        return {
            poolAddress: pool.id.toBase58(),
            tokenA: {
                mint: pool.tokenMintA.toBase58(),
                decimals: pool.tokenMintADecimals,
                reserve: normalizeReserve(pool.tokenAReserve, pool.tokenMintADecimals),
            },
            tokenB: {
                mint: pool.tokenMintB.toBase58(),
                decimals: pool.tokenMintBDecimals,
                reserve: normalizeReserve(pool.tokenBReserve, pool.tokenMintBDecimals),
            },
            liquidity: {
                totalSupply: normalizeReserve(pool.liquidity, pool.tokenMintADecimals),
                openOrdersAddress: pool.openOrders.toBase58(),
                lpMint: pool.lpMint.toBase58(),
            },
            fees: {
                tradeFeePercentage,
                ownerFeePercentage,
                rawNumerators: {
                    tradeFeeNumerator: pool.tradeFeeNumerator,
                    tradeFeeDenominator: pool.tradeFeeDenominator,
                    ownerFeeNumerator: pool.ownerFeeNumerator,
                    ownerFeeDenominator: pool.ownerFeeDenominator,
                },
            },
        };
    });

    return poolInfo;
}

// ret mech
async function establishConnectionWithRetry(endpoint: string, retries: number): Promise<Connection> {
    let attempt = 0;
    while (attempt < retries) {
        try {
            const connection = new Connection(endpoint, "confirmed");
            await connection.getVersion();
            return connection;
        } catch (error) {
            attempt++;
            console.warn(`Connection attempt ${attempt} failed. Retrying...`);
            if (attempt >= retries) throw new Error("Failed to establish RPC connection after multiple attempts.");
        }
    }
}

function normalizeReserve(reserve: bigint, decimals: number): string {
    return (Number(reserve) / Math.pow(10, decimals)).toFixed(decimals);
}

(async () => {
    try {
        const pools = await fetchRaydiumPools();
        console.log("Raydium Pools:", JSON.stringify(pools, null, 2));
    } catch (error) {
        console.error("bruh:", error.message);
    }
})();

