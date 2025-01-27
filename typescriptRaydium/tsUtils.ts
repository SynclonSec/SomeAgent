import { Connection, PublicKey } from "@solana/web3.js";
import tokenList from "@solana/spl-token-registry";
import { LiquidityPoolKeys } from "@raydium-io/raydium-sdk";
import { TokenMetadata, PoolFilterCriteria } from "./types";

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export async function establishConnectionWithRetry(
    endpoint: string, 
    retries: number = 3
): Promise<Connection> {
    let attempt = 0;
    while (attempt < retries) {
        try {
            const connection = new Connection(endpoint, "confirmed");
            await connection.getVersion();
            return connection;
        } catch (error) {
            attempt++;
            if (attempt >= retries) throw new Error(
                `Failed to connect after ${retries} attempts: ${sanitizeError(error)}`
            );
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
    throw new Error("Connection establishment failed unexpectedly");
}

export function buildTokenMetadataMap(chainId: number = 101): Map<string, TokenMetadata> {
    const tokenMap = new Map<string, TokenMetadata>();
    tokenList.filterByChainId(chainId).getList().forEach(token => {
        tokenMap.set(token.address, {
            mint: token.address,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoURI: token.logoURI
        });
    });
    return tokenMap;
}

export async function getAssociatedTokenAddress(
    owner: PublicKey,
    mint: PublicKey
): Promise<PublicKey> {
    return (await PublicKey.findProgramAddress(
        [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        ASSOCIATED_TOKEN_PROGRAM_ID
    ))[0];
}

export function toBaseUnits(amount: number, decimals: number): number {
    return Math.round(amount * Math.pow(10, decimals));
}

export function toHumanUnits(amount: number, decimals: number): number {
    return amount / Math.pow(10, decimals);
}


export function filterPools(
    pools: LiquidityPoolKeys[],
    criteria: PoolFilterCriteria
): LiquidityPoolKeys[] {
    return pools.filter(pool => {
        const baseReserve = pool.baseReserve.toNumber();
        const quoteReserve = pool.quoteReserve.toNumber();
        
        const reserveCheck = (!criteria.minReserve || 
            (baseReserve >= criteria.minReserve && quoteReserve >= criteria.minReserve)) &&
            (!criteria.maxReserve || 
            (baseReserve <= criteria.maxReserve && quoteReserve <= criteria.maxReserve));

        const mintCheck = !criteria.allowedMints || 
            criteria.allowedMints.includes(pool.baseMint.toString()) ||
            criteria.allowedMints.includes(pool.quoteMint.toString());

        return reserveCheck && mintCheck;
    });
}

export function sanitizeError(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    return msg
        .replace(/[^\w\s]/gi, '')
        .replace(/(secret|private|mnemonic|key)/gi, '*****')
        .substring(0, 200);
}

export function validatePublicKey(address: string): PublicKey {
    try {
        return new PublicKey(address);
    } catch (error) {
        throw new Error(`Invalid public key format: ${sanitizeError(error)}`);
    }
}

export function validateMintAddresses(
    sourceMint: string,
    targetMint: string
): void {
    validatePublicKey(sourceMint);
    validatePublicKey(targetMint);
    if (sourceMint === targetMint) {
        throw new Error("Source and target tokens must be different");
    }
}
