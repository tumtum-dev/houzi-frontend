import { getAddress, isAddress, type Address } from "viem";

export type Token = {
  address: Address | null;
  decimals: number;
  imported?: boolean;
  isNative?: boolean;
  name: string;
  symbol: string;
};

export const WNATIVE_ADDRESS = getAddress(
  "0x48b62137EdfA95a428D35C09E44256a739F6B557",
);

export const APEUSD_ADDRESS = getAddress(
  "0xA2235d059F80e176D931Ef76b6C51953Eb3fBEf4",
);

export const ROUTER_ADDRESS = getAddress(
  "0xC69Dc28924930583024E067b2B3d773018F4EB52",
);

export const QUOTER_ADDRESS = getAddress(
  "0x60A186019F81bFD04aFc16c9C01804a04E79e68B",
);

export const nativeApeToken: Token = {
  address: null,
  decimals: 18,
  isNative: true,
  name: "ApeCoin",
  symbol: "APE",
};

export const wNativeToken: Token = {
  address: WNATIVE_ADDRESS,
  decimals: 18,
  name: "Wrapped ApeCoin",
  symbol: "WAPE",
};

export const apeUsdToken: Token = {
  address: APEUSD_ADDRESS,
  decimals: 18,
  name: "APEUSD",
  symbol: "APEUSD",
};

export const defaultFromTokens: Token[] = [nativeApeToken, wNativeToken, apeUsdToken];

export const IMPORTED_TOKENS_STORAGE_KEY = "houzi.swapper.imported.v1";
export const BINARY_ANIMATION_STORAGE_KEY = "houzi.swapper.binary.v1";

type StoredToken = {
  address: Address;
  decimals: number;
  name: string;
  symbol: string;
};

export function normalizeAddress(value: string | null | undefined) {
  if (!value || !isAddress(value)) {
    return null;
  }

  return getAddress(value);
}

export function getTokenAddressForRouter(token: Token) {
  return token.isNative ? WNATIVE_ADDRESS : token.address;
}

export function isSameToken(left: Token | null, right: Token | null) {
  if (!left || !right) {
    return false;
  }

  if (left.isNative && right.isNative) {
    return true;
  }

  return left.address !== null && left.address === right.address;
}

export function loadImportedTokens(): Token[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(IMPORTED_TOKENS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as StoredToken[];
    return parsed
      .filter((token) => isAddress(token.address))
      .map((token) => ({
        address: getAddress(token.address),
        decimals: token.decimals,
        imported: true,
        name: token.name,
        symbol: token.symbol,
      }));
  } catch {
    return [];
  }
}

export function saveImportedTokens(tokens: Token[]) {
  if (typeof window === "undefined") {
    return;
  }

  const serialized = tokens
    .filter((token) => token.address !== null)
    .map((token) => ({
      address: token.address,
      decimals: token.decimals,
      name: token.name,
      symbol: token.symbol,
    }));

  window.localStorage.setItem(
    IMPORTED_TOKENS_STORAGE_KEY,
    JSON.stringify(serialized),
  );
}
