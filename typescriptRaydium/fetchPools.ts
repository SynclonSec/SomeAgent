import { Connection, PublicKey } from "@solana/web3.js";
import { Liquidity, LIQUIDITY_PROGRAM_ID_V4 } from "@raydium-io/raydium-sdk";
import tokenList from "@solana/spl-token-registry"; // Add SPL Token Registry or equivalent library

interface TokenMetadata {
    mint: string;
    symbol: string;
    name: string;
    decimals: number;
    logoURI?: string;
}

interface PoolInfo {
    poolAddress: string;
    tokenA: TokenMetadata & { reserve: string };
    tokenB: TokenMetadata & { reserve: string };
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

    /*
    -token metadata
    -quick lookup retrieval

    
    */
    const tokenMetadataMap = buildTokenMetadataMap();

    const validPools = pools.filter(
        (pool) => pool.tokenAReserve.gt(0) && pool.tokenBReserve.gt(0)
    );

    const poolInfo = validPools.map((pool) => {
        const tradeFeePercentage = (
            (pool.tradeFeeNumerator / pool.tradeFeeDenominator) * 100
        ).toFixed(2);
        const ownerFeePercentage = (
            (pool.ownerFeeNumerator / pool.ownerFeeDenominator) * 100
        ).toFixed(2);

        const tokenAInfo = tokenMetadataMap.get(pool.tokenMintA.toBase58()) || {
            mint: pool.tokenMintA.toBase58(),
            symbol: "UNKNOWN",
            name: "Unknown Token",
            decimals: pool.tokenMintADecimals,
        };

        const tokenBInfo = tokenMetadataMap.get(pool.tokenMintB.toBase58()) || {
            mint: pool.tokenMintB.toBase58(),
            symbol: "UNKNOWN",
            name: "Unknown Token",
            decimals: pool.tokenMintBDecimals,
        };

        return {
            poolAddress: pool.id.toBase58(),
            tokenA: {
                ...tokenAInfo,
                reserve: normalizeReserve(pool.tokenAReserve, tokenAInfo.decimals),
            },
            tokenB: {
                ...tokenBInfo,
                reserve: normalizeReserve(pool.tokenBReserve, tokenBInfo.decimals),
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

function buildTokenMetadataMap(): Map<string, TokenMetadata> {
    const tokenMap = new Map<string, TokenMetadata>();
    const tokenRegistry = tokenList.filterByChainId(101); // Mainnet chain ID

    tokenRegistry.getList().forEach((token) => {
        tokenMap.set(token.address, {
            mint: token.address,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoURI: token.logoURI,
        });
    });

    return tokenMap;
}

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
            if (attempt >= retries)
                throw new Error("Failed to establish RPC connection after multiple attempts.");
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
        console.error("Error:", error.message);
    }
})();
