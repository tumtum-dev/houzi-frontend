"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { encodeFunctionData, parseUnits, type Address } from "viem";
import { useAccount, useBalance, useSwitchChain, useWalletClient } from "wagmi";
import {
  addWalletWatchAsset,
  applySlippage,
  approveMaxToken,
  buildRoutePath,
  fetchTokenMetadata,
  formatAddress,
  formatDisplayAmount,
  quoteBestRoute,
  readAllowance,
  routerAbi,
} from "@/lib/swap";
import {
  BINARY_ANIMATION_STORAGE_KEY,
  defaultFromTokens,
  isSameToken,
  loadImportedTokens,
  nativeApeToken,
  normalizeAddress,
  ROUTER_ADDRESS,
  saveImportedTokens,
  type Token,
  WNATIVE_ADDRESS,
} from "@/lib/tokens";
import {
  apeChain,
  apePublicClient,
  APECHAIN_EXPLORER_URL,
} from "@/lib/web3";

type QuoteState = {
  amountOut: bigint;
  path: Address[];
  routeType: "direct" | "multihop";
} | null;

type TokenModalState = {
  isOpen: boolean;
  loading: boolean;
  mode: "houzi-token" | "pair-token";
  pendingImport: Token | null;
  query: string;
};

const DEFAULT_SLIPPAGE = "1.0";
const DEADLINE_SECONDS = 60 * 20;

export function Swapper({ houziAddress }: { houziAddress: Address | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { address: account, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

  const [selectedPairToken, setSelectedPairToken] = useState<Token>(nativeApeToken);
  const [houziToken, setHouziToken] = useState<Token | null>(null);
  const [houziLoadError, setHouziLoadError] = useState<string | null>(null);
  const [importedTokens, setImportedTokens] = useState<Token[]>([]);
  const [isReversed, setIsReversed] = useState(false);
  const [amountIn, setAmountIn] = useState("");
  const [slippageInput, setSlippageInput] = useState(DEFAULT_SLIPPAGE);
  const [quote, setQuote] = useState<QuoteState>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [binaryEnabled, setBinaryEnabled] = useState(true);
  const [selectorState, setSelectorState] = useState<TokenModalState>({
    isOpen: false,
    loading: false,
    mode: "pair-token",
    pendingImport: null,
    query: "",
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [allowanceLoading, setAllowanceLoading] = useState(false);
  const [, startTransition] = useTransition();

  const deferredAmountIn = useDeferredValue(amountIn.trim());

  useEffect(() => {
    queueMicrotask(() => {
      setImportedTokens(loadImportedTokens());

      if (typeof window === "undefined") {
        return;
      }

      const stored = window.localStorage.getItem(BINARY_ANIMATION_STORAGE_KEY);
      if (stored !== null) {
        setBinaryEnabled(stored === "true");
      }
    });
  }, []);

  const effectiveHouziToken = houziAddress ? houziToken : null;
  const houziError = !houziAddress
    ? "Pass a valid Houzi token in the `to` query parameter."
    : houziLoadError;

  useEffect(() => {
    if (!houziAddress) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setHouziLoadError(null);
      }
    });

    fetchTokenMetadata(houziAddress)
      .then((token) => {
        if (!cancelled) {
          setHouziToken({ ...token, imported: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHouziToken(null);
          setHouziLoadError("Unable to load the Houzi token metadata from ApeChain.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [houziAddress]);

  const availablePairTokens = useMemo(() => {
    const merged = [...defaultFromTokens, ...importedTokens];
    const unique = new Map<string, Token>();

    for (const token of merged) {
      const key = token.isNative ? "native" : token.address ?? token.symbol;
      if (!unique.has(key)) {
        unique.set(key, token);
      }
    }

    return Array.from(unique.values()).filter(
      (token) => !isSameToken(token, effectiveHouziToken),
    );
  }, [effectiveHouziToken, importedTokens]);

  const effectivePairToken = useMemo(() => {
    if (!effectiveHouziToken || !isSameToken(selectedPairToken, effectiveHouziToken)) {
      return selectedPairToken;
    }

    return availablePairTokens[0] ?? nativeApeToken;
  }, [availablePairTokens, effectiveHouziToken, selectedPairToken]);

  const effectiveFromToken = isReversed ? effectiveHouziToken : effectivePairToken;
  const effectiveToToken = isReversed ? effectivePairToken : effectiveHouziToken;

  const parsedAmountIn = useMemo(() => {
    if (!deferredAmountIn || !effectiveFromToken) {
      return null;
    }

    try {
      return parseUnits(deferredAmountIn, effectiveFromToken.decimals);
    } catch {
      return null;
    }
  }, [deferredAmountIn, effectiveFromToken]);

  const slippageBps = useMemo(() => parseSlippageInput(slippageInput), [slippageInput]);
  const slippageError = getSlippageError(slippageInput, slippageBps);

  const canQuote = Boolean(
    effectiveFromToken && effectiveToToken && parsedAmountIn && parsedAmountIn > 0n,
  );
  const effectiveQuote = canQuote ? quote : null;
  const effectiveQuoteError = canQuote ? quoteError : null;

  useEffect(() => {
    if (!effectiveFromToken || !effectiveToToken || !parsedAmountIn || parsedAmountIn <= 0n) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setQuoteLoading(true);
        setQuoteError(null);
      }
    });

    quoteBestRoute(effectiveFromToken, effectiveToToken, parsedAmountIn)
      .then((nextQuote) => {
        if (cancelled) {
          return;
        }

        setQuote(nextQuote);
        if (!nextQuote) {
          setQuoteError("No route found for this swap direction.");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQuote(null);
          setQuoteError("Quote failed. Check the pair and try again.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setQuoteLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [effectiveFromToken, effectiveToToken, parsedAmountIn]);

  useEffect(() => {
    if (
      !account ||
      !effectiveFromToken ||
      effectiveFromToken.isNative ||
      !effectiveFromToken.address ||
      !parsedAmountIn ||
      !isConnected
    ) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setAllowanceLoading(true);
      }
    });

    readAllowance(effectiveFromToken.address, account)
      .then((value) => {
        if (!cancelled) {
          setAllowance(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAllowance(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAllowanceLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [account, effectiveFromToken, isConnected, parsedAmountIn]);

  const fromBalance = useBalance({
    address: account,
    chainId: apeChain.id,
    token:
      effectiveFromToken && !effectiveFromToken.isNative
        ? effectiveFromToken.address ?? undefined
        : undefined,
    query: {
      enabled: Boolean(account && effectiveFromToken),
      refetchInterval: 10_000,
    },
  });

  const toBalance = useBalance({
    address: account,
    chainId: apeChain.id,
    token:
      effectiveToToken && !effectiveToToken.isNative
        ? effectiveToToken.address ?? undefined
        : undefined,
    query: {
      enabled: Boolean(account && effectiveToToken && !effectiveToToken.isNative),
      refetchInterval: 10_000,
    },
  });

  const insufficientBalance =
    parsedAmountIn !== null && fromBalance.data ? parsedAmountIn > fromBalance.data.value : false;

  const needsApproval =
    effectiveFromToken !== null
      ? !effectiveFromToken.isNative &&
        parsedAmountIn !== null &&
        allowance !== null &&
        allowance < parsedAmountIn
      : false;

  const minimumOut =
    effectiveQuote && effectiveToToken && slippageBps !== null
      ? applySlippage(effectiveQuote.amountOut, slippageBps)
      : null;

  const actionDisabled =
    actionLoading ||
    !effectiveFromToken ||
    !effectiveToToken ||
    !parsedAmountIn ||
    parsedAmountIn <= 0n ||
    !effectiveQuote ||
    insufficientBalance ||
    Boolean(houziError) ||
    Boolean(slippageError) ||
    slippageBps === null;

  async function ensureApeChain() {
    if (chainId === apeChain.id) {
      return;
    }

    await switchChainAsync({ chainId: apeChain.id });
  }

  async function refreshAllowance() {
    if (!account || !effectiveFromToken || effectiveFromToken.isNative || !effectiveFromToken.address) {
      return;
    }

    const nextAllowance = await readAllowance(effectiveFromToken.address, account);
    setAllowance(nextAllowance);
  }

  async function handleApprove() {
    if (!account || !walletClient || !effectiveFromToken?.address) {
      return;
    }

    setActionError(null);
    setActionMessage(null);
    setActionLoading(true);

    try {
      await ensureApeChain();
      const hash = await approveMaxToken({
        owner: account,
        tokenAddress: effectiveFromToken.address,
        walletClient,
      });
      await refreshAllowance();
      setActionMessage(`Approval confirmed: ${hash}`);
    } catch (error) {
      setActionError(getReadableError(error));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSwap() {
    if (
      !walletClient ||
      !account ||
      !effectiveQuote ||
      !effectiveFromToken ||
      !effectiveToToken ||
      !parsedAmountIn ||
      minimumOut === null
    ) {
      return;
    }

    const tokenInAddress = effectiveFromToken.isNative ? WNATIVE_ADDRESS : effectiveFromToken.address;
    const tokenOutAddress = effectiveToToken.isNative ? WNATIVE_ADDRESS : effectiveToToken.address;

    if (!tokenInAddress || !tokenOutAddress) {
      setActionError("Missing token addresses for the router call.");
      return;
    }

    setActionError(null);
    setActionMessage(null);
    setActionLoading(true);

    try {
      await ensureApeChain();

      const deadline = createSwapDeadline();
      const value = effectiveFromToken.isNative ? parsedAmountIn : 0n;
      const recipient = effectiveToToken.isNative ? ROUTER_ADDRESS : account;

      const swapCallData =
        effectiveQuote.routeType === "direct"
          ? encodeFunctionData({
              abi: routerAbi,
              functionName: "exactInputSingle",
              args: [
                {
                  tokenIn: tokenInAddress,
                  tokenOut: tokenOutAddress,
                  recipient,
                  deadline,
                  amountIn: parsedAmountIn,
                  amountOutMinimum: minimumOut,
                  limitSqrtPrice: 0n,
                },
              ],
            })
          : encodeFunctionData({
              abi: routerAbi,
              functionName: "exactInput",
              args: [
                {
                  path: buildRoutePath(effectiveQuote.path),
                  recipient,
                  deadline,
                  amountIn: parsedAmountIn,
                  amountOutMinimum: minimumOut,
                },
              ],
            });

      const hash = effectiveToToken.isNative
        ? await walletClient.writeContract({
            address: ROUTER_ADDRESS,
            abi: routerAbi,
            functionName: "multicall",
            args: [
              [
                swapCallData,
                encodeFunctionData({
                  abi: routerAbi,
                  functionName: "unwrapWNativeToken",
                  args: [minimumOut, account],
                }),
              ],
            ],
            account,
            chain: apeChain,
            value,
          })
        : await walletClient.writeContract({
            address: ROUTER_ADDRESS,
            abi: routerAbi,
            functionName: effectiveQuote.routeType === "direct" ? "exactInputSingle" : "exactInput",
            args:
              effectiveQuote.routeType === "direct"
                ? [
                    {
                      tokenIn: tokenInAddress,
                      tokenOut: tokenOutAddress,
                      recipient,
                      deadline,
                      amountIn: parsedAmountIn,
                      amountOutMinimum: minimumOut,
                      limitSqrtPrice: 0n,
                    },
                  ]
                : [
                    {
                      path: buildRoutePath(effectiveQuote.path),
                      recipient,
                      deadline,
                      amountIn: parsedAmountIn,
                      amountOutMinimum: minimumOut,
                    },
                  ],
            account,
            chain: apeChain,
            value,
          });

      await apePublicClient.waitForTransactionReceipt({ hash });
      fromBalance.refetch();
      toBalance.refetch();
      setActionMessage(`Swap confirmed: ${hash}`);
    } catch (error) {
      setActionError(getReadableError(error));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleImportByAddress() {
    const normalized = normalizeAddress(selectorState.query.trim());
    if (!normalized) {
      setSelectorState((current) => ({
        ...current,
        pendingImport: null,
      }));
      setActionError("Enter a valid token address to import.");
      return;
    }

    setActionError(null);
    setSelectorState((current) => ({ ...current, loading: true }));

    try {
      const token = await fetchTokenMetadata(normalized);
      setSelectorState((current) => ({
        ...current,
        loading: false,
        pendingImport: token,
      }));
    } catch {
      setSelectorState((current) => ({
        ...current,
        loading: false,
        pendingImport: null,
      }));
      setActionError("Token metadata could not be loaded from ApeChain.");
    }
  }

  async function finalizeImport(token: Token) {
    persistImportedToken(token);

    await addWalletWatchAsset(token);

    if (selectorState.mode === "houzi-token" && token.address) {
      setHouziTokenInUrl(token.address);
      setSelectorState({
        isOpen: false,
        loading: false,
        mode: selectorState.mode,
        pendingImport: null,
        query: "",
      });
      return;
    }

    startTransition(() => {
      setSelectedPairToken(token);
      setSelectorState({
        isOpen: false,
        loading: false,
        mode: selectorState.mode,
        pendingImport: null,
        query: "",
      });
    });
  }

  const filteredTokens = useMemo(() => {
    const query = selectorState.query.trim().toLowerCase();
    const pool =
      selectorState.mode === "pair-token"
        ? availablePairTokens
        : importedTokens.filter((token) => token.address !== null);

    if (!query) {
      return pool;
    }

    return pool.filter((token) => {
      const address = token.address?.toLowerCase() ?? "";
      return (
        token.symbol.toLowerCase().includes(query) ||
        token.name.toLowerCase().includes(query) ||
        address.includes(query)
      );
    });
  }, [availablePairTokens, importedTokens, selectorState.mode, selectorState.query]);

  const primaryButtonLabel = !isConnected
    ? "Connect wallet"
    : chainId !== apeChain.id
      ? "Switch to ApeChain"
      : needsApproval && effectiveFromToken
        ? `Approve ${effectiveFromToken.symbol}`
        : `Swap to ${effectiveToToken?.symbol ?? "token"}`;

  async function handlePrimaryAction() {
    if (!isConnected || !walletClient) {
      return;
    }

    if (chainId !== apeChain.id) {
      try {
        await ensureApeChain();
      } catch (error) {
        setActionError(getReadableError(error));
      }
      return;
    }

    if (needsApproval) {
      await handleApprove();
      return;
    }

    await handleSwap();
  }

  function openSelector(mode: "houzi-token" | "pair-token") {
    setSelectorState({
      isOpen: true,
      loading: false,
      mode,
      pendingImport: null,
      query: "",
    });
  }

  function setHouziTokenInUrl(address: Address) {
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.set("to", address);
    router.replace(`${pathname}?${nextParams.toString()}`, { scroll: false });
  }

  function persistImportedToken(token: Token) {
    const nextImported = [...importedTokens];
    if (!nextImported.some((item) => item.address === token.address)) {
      nextImported.unshift({ ...token, imported: true });
      setImportedTokens(nextImported);
      saveImportedTokens(nextImported);
    }

    return nextImported;
  }

  async function handleSelectToken(token: Token) {
    if (selectorState.mode === "pair-token") {
      startTransition(() => {
        setSelectedPairToken(token);
        setSelectorState({
          isOpen: false,
          loading: false,
          mode: selectorState.mode,
          pendingImport: null,
          query: "",
        });
      });
      return;
    }

    if (!token.address) {
      return;
    }

    persistImportedToken(token);
    setHouziTokenInUrl(token.address);
    setSelectorState({
      isOpen: false,
      loading: false,
      mode: selectorState.mode,
      pendingImport: null,
      query: "",
    });
  }

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-[#030303] px-6 py-10 text-[#f5f5f5]">
      {binaryEnabled ? <BinaryBackground /> : null}

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,77,87,0.18),transparent_34%),radial-gradient(circle_at_top,rgba(255,77,87,0.08),transparent_45%)]" />

      <div className="absolute left-4 top-4 z-20 sm:left-6 sm:top-6">
        <StyledConnectButton />
      </div>

      <div className="absolute right-4 top-4 z-20 flex items-center gap-3 rounded-full border border-[#5f151a] bg-black/70 px-4 py-2 text-xs uppercase tracking-[0.28em] text-[#ff8b92] backdrop-blur-sm sm:right-6 sm:top-6">
        <span>Binary</span>
        <button
          type="button"
          className={`relative h-6 w-12 rounded-full border transition ${
            binaryEnabled
              ? "border-[#ff4d57] bg-[#3b0b10]"
              : "border-[#343434] bg-[#131313]"
          }`}
          onClick={() => {
            const next = !binaryEnabled;
            setBinaryEnabled(next);
            window.localStorage.setItem(BINARY_ANIMATION_STORAGE_KEY, String(next));
          }}
          aria-label="Toggle binary animation"
        >
          <span
            className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-[#ff4d57] transition ${
              binaryEnabled ? "left-6" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <main className="relative z-10 flex w-full max-w-xl flex-col items-center justify-center">
        <div className="mb-8 flex flex-col items-center gap-5 text-center">
          <div className="relative h-28 w-28 overflow-hidden rounded-full border border-[#791d24] bg-black/70 shadow-[0_0_60px_rgba(255,77,87,0.18)] sm:h-36 sm:w-36">
            <Image src="/logo.jpg" alt="Houzi logo" fill priority className="object-cover" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-[0.22em] text-[#ff4d57] uppercase">
              Houzi Swapper
            </h1>
            <p className="mt-2 text-sm text-[#c7a1a4]">
              Route between Houzi and ApeChain assets in either direction.
            </p>
          </div>
        </div>

        <section className="w-full rounded-[2rem] border border-[#491116] bg-black/75 p-5 shadow-[0_0_90px_rgba(255,77,87,0.12)] backdrop-blur-md sm:p-6">
          <TokenPanel
            label="From"
            token={effectiveFromToken}
            amount={amountIn}
            onAmountChange={setAmountIn}
            onTokenClick={() => openSelector(isReversed ? "houzi-token" : "pair-token")}
            balance={fromBalance.data?.formatted}
            balanceSymbol={fromBalance.data?.symbol}
          />

          <div className="my-3 flex justify-center">
            <button
              type="button"
              onClick={() => setIsReversed((current) => !current)}
              className="flex items-center gap-3 rounded-full border border-[#4d1218] bg-[#100607] px-4 py-2 font-mono text-[11px] uppercase tracking-[0.28em] text-[#ff646d] transition hover:border-[#ff4d57] hover:bg-[#17090b]"
            >
              <span>Flip</span>
              <SwapDirectionIcon className="h-3.5 w-3.5" />
            </button>
          </div>

          <TokenPanel
            label="To"
            token={effectiveToToken}
            amount={
              effectiveQuote && effectiveToToken
                ? formatDisplayAmount(effectiveQuote.amountOut, effectiveToToken.decimals)
                : ""
            }
            balance={toBalance.data?.formatted}
            balanceSymbol={toBalance.data?.symbol}
            onTokenClick={() => openSelector(isReversed ? "pair-token" : "houzi-token")}
            readOnly
          />

          <div className="mt-4 space-y-3 rounded-[1.4rem] border border-[#331012] bg-[#0a0a0a] px-4 py-4 text-sm text-[#c8aaad]">
            {effectiveHouziToken?.address ? (
              <LinkedInfoRow
                label="Houzi token"
                href={`https://apescan.io/token/${effectiveHouziToken.address}`}
                value={formatAddress(effectiveHouziToken.address)}
              />
            ) : (
              <InfoRow label="Houzi token" value="Missing" mono />
            )}
            <InfoRow
              label="Route"
              value={
                effectiveQuote
                  ? effectiveQuote.routeType === "multihop"
                    ? "Fallback via WAPE"
                    : "Direct"
                  : "-"
              }
            />
            <EditableInfoRow
              label="Slippage %"
              value={slippageInput}
              onChange={setSlippageInput}
            />
            <InfoRow
              label="Minimum received"
              value={
                minimumOut !== null && effectiveToToken
                  ? `${formatDisplayAmount(minimumOut, effectiveToToken.decimals)} ${effectiveToToken.symbol}`
                  : "-"
              }
            />
            <InfoRow
              label="Path"
              value={
                effectiveQuote
                  ? effectiveQuote.path.map((address) => formatAddress(address)).join(" -> ")
                  : "-"
              }
              mono
            />
          </div>

          {houziError ? <Notice tone="error">{houziError}</Notice> : null}
          {slippageError ? <Notice tone="error">{slippageError}</Notice> : null}
          {quoteLoading ? <Notice tone="info">Fetching quote...</Notice> : null}
          {!quoteLoading && effectiveQuoteError ? <Notice tone="error">{effectiveQuoteError}</Notice> : null}
          {insufficientBalance && effectiveFromToken ? (
            <Notice tone="error">Insufficient {effectiveFromToken.symbol} balance.</Notice>
          ) : null}
          {actionError ? <Notice tone="error">{actionError}</Notice> : null}
          {actionMessage ? (
            <Notice tone="success">
              <a
                href={`${APECHAIN_EXPLORER_URL}/tx/${actionMessage.split(": ")[1] ?? ""}`}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-[#ff4d57]/40 underline-offset-4"
              >
                {actionMessage}
              </a>
            </Notice>
          ) : null}

          <button
            type="button"
            className="mt-5 w-full rounded-[1.2rem] border border-[#ff4d57] bg-[#ff4d57] px-5 py-4 text-sm font-semibold uppercase tracking-[0.26em] text-[#120204] transition hover:bg-[#ff616a] disabled:cursor-not-allowed disabled:border-[#4d1b20] disabled:bg-[#1a0a0c] disabled:text-[#775a5d]"
            onClick={handlePrimaryAction}
            disabled={!isConnected || actionDisabled || allowanceLoading}
          >
            {actionLoading || allowanceLoading ? "Working..." : primaryButtonLabel}
          </button>
        </section>
      </main>

      <TokenSelectorModal
        filteredTokens={filteredTokens}
        isOpen={selectorState.isOpen}
        loading={selectorState.loading}
        pendingImport={selectorState.pendingImport}
        query={selectorState.query}
        onClose={() =>
          setSelectorState({
            isOpen: false,
            loading: false,
            mode: selectorState.mode,
            pendingImport: null,
            query: "",
          })
        }
        onImport={finalizeImport}
        onLoadImport={handleImportByAddress}
        onQueryChange={(query) =>
          setSelectorState((current) => ({
            ...current,
            pendingImport: null,
            query,
          }))
        }
        onSelect={handleSelectToken}
        title={selectorState.mode === "pair-token" ? "Select Token" : "Set Houzi Token"}
        description={
          selectorState.mode === "pair-token"
            ? "Choose a default or previously imported token."
            : "Paste a contract address or reuse an imported token for the Houzi side."
        }
        showImportAction={selectorState.mode === "houzi-token"}
      />
    </div>
  );
}

function StyledConnectButton() {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        authenticationStatus,
        openAccountModal,
        openChainModal,
        openConnectModal,
      }) => {
        const ready = mounted && authenticationStatus !== "loading";
        const connected = ready && account && chain;

        if (!connected) {
          return (
            <button type="button" className={buttonClassName} onClick={openConnectModal}>
              Connect Wallet
            </button>
          );
        }

        if (chain.unsupported) {
          return (
            <button type="button" className={buttonClassName} onClick={openChainModal}>
              Wrong Network
            </button>
          );
        }

        return (
          <button type="button" className={buttonClassName} onClick={openAccountModal}>
            {account.displayName}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}

function BinaryBackground() {
  const [viewport, setViewport] = useState({ columns: 36, rows: 28 });

  useEffect(() => {
    const updateViewport = () => {
      const columns = Math.max(20, Math.ceil(window.innerWidth / 24));
      const rows = Math.max(18, Math.ceil(window.innerHeight / 26));
      setViewport({ columns, rows });
    };

    window.addEventListener("resize", updateViewport);
    queueMicrotask(updateViewport);

    return () => {
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  const fieldText = useMemo(() => {
    const totalRows = viewport.rows * 2;
    return Array.from({ length: totalRows }, (_, rowIndex) =>
      Array.from({ length: viewport.columns }, (_, columnIndex) =>
        (rowIndex + columnIndex) % 3 ? "1" : "0",
      ).join(" "),
    ).join("\n");
  }, [viewport.columns, viewport.rows]);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="binary-field-track absolute inset-0 font-mono text-[22px] leading-[1.65] tracking-[0.45em] text-[#ff3b47] opacity-30">
        <pre className="binary-field-content">{fieldText}</pre>
      </div>
    </div>
  );
}

function TokenPanel({
  amount,
  balance,
  balanceSymbol,
  label,
  onAmountChange,
  onTokenClick,
  readOnly,
  token,
}: {
  amount: string;
  balance?: string;
  balanceSymbol?: string;
  label: string;
  onAmountChange?: (value: string) => void;
  onTokenClick?: () => void;
  readOnly?: boolean;
  token: Token | null;
}) {
  return (
    <div className="rounded-[1.6rem] border border-[#351013] bg-[#090909] p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between text-[11px] uppercase tracking-[0.32em] text-[#a1686c]">
        <span>{label}</span>
        <span>
          Balance: {balance ? `${Number(balance).toFixed(4)} ${balanceSymbol ?? ""}` : "-"}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className={`flex min-h-[72px] min-w-[10rem] items-center justify-between rounded-[1.15rem] border px-4 py-3 text-left transition ${
            onTokenClick
              ? "border-[#612127] bg-[#17090b] text-white hover:border-[#ff4d57]"
              : "cursor-default border-[#41161a] bg-[#130708] text-[#f0b0b4]"
          }`}
          onClick={onTokenClick}
        >
          <span>
            <span className="block text-sm font-semibold uppercase tracking-[0.18em]">
              {token?.symbol ?? "Loading"}
            </span>
            <span className="mt-1 block text-xs text-[#b68a8d]">
              {token?.name ?? "Loading token"}
            </span>
          </span>
          {onTokenClick ? <ChevronDownIcon className="h-4 w-4 text-[#ff4d57]" /> : null}
        </button>

        <div
          className={`flex min-h-[72px] w-full items-center rounded-[1.15rem] border bg-[#14090b] px-4 py-3 shadow-[0_0_0_1px_rgba(255,77,87,0.12)] transition ${
            readOnly
              ? "border-[#4a171c]"
              : "border-[#7f1f29] focus-within:border-[#ff4d57] focus-within:shadow-[0_0_0_1px_rgba(255,77,87,0.34),0_0_18px_rgba(255,77,87,0.16)]"
          }`}
        >
          <input
            value={amount}
            onChange={(event) => onAmountChange?.(event.target.value)}
            readOnly={readOnly}
            placeholder="0.00"
            inputMode="decimal"
            className="w-full border-none bg-transparent text-right font-mono text-3xl font-semibold text-white outline-none placeholder:text-[#4d3335]"
          />
        </div>
      </div>
    </div>
  );
}

function TokenSelectorModal({
  description,
  filteredTokens,
  isOpen,
  loading,
  onClose,
  onImport,
  onLoadImport,
  onQueryChange,
  onSelect,
  pendingImport,
  query,
  showImportAction,
  title,
}: {
  description: string;
  filteredTokens: Token[];
  isOpen: boolean;
  loading: boolean;
  onClose: () => void;
  onImport: (token: Token) => void;
  onLoadImport: () => void;
  onQueryChange: (query: string) => void;
  onSelect: (token: Token) => void;
  pendingImport: Token | null;
  query: string;
  showImportAction: boolean;
  title: string;
}) {
  if (!isOpen) {
    return null;
  }

  if (typeof document === "undefined") {
    return null;
  }

  const maybeAddress = normalizeAddress(query);

  return createPortal(
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-[1.8rem] border border-[#4d1419] bg-[#060606] p-5 shadow-[0_0_80px_rgba(255,77,87,0.16)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-[0.28em] text-[#ff6a73]">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="text-[#b27e82] transition hover:text-white">
            Close
          </button>
        </div>

        <p className="mb-4 text-sm text-[#b48a8e]">{description}</p>

        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={showImportAction ? "Paste token address or search imports" : "Search symbol, name, or address"}
          className="mb-4 w-full rounded-[1.1rem] border border-[#341014] bg-[#0f0f0f] px-4 py-3 text-sm text-white outline-none placeholder:text-[#5c4042] focus:border-[#ff4d57]"
        />

        {showImportAction && maybeAddress && !filteredTokens.some((token) => token.address === maybeAddress) ? (
          <button
            type="button"
            onClick={onLoadImport}
            className="mb-4 w-full rounded-[1.1rem] border border-[#5f2127] bg-[#14090b] px-4 py-3 text-sm uppercase tracking-[0.18em] text-[#ffc4c8] transition hover:border-[#ff4d57]"
          >
            {loading ? "Loading token..." : "Load token from address"}
          </button>
        ) : null}

        {pendingImport ? (
          <button
            type="button"
            onClick={() => onImport(pendingImport)}
            className="mb-4 flex w-full items-center justify-between rounded-[1.1rem] border border-[#ff4d57] bg-[#17090b] px-4 py-3 text-left text-white"
          >
            <span>
              <span className="block text-sm font-semibold uppercase tracking-[0.16em]">
                {pendingImport.symbol}
              </span>
              <span className="mt-1 block text-xs text-[#c29ca0]">{pendingImport.name}</span>
            </span>
            <span className="text-xs uppercase tracking-[0.22em] text-[#ff8088]">Import</span>
          </button>
        ) : null}

        <div className="space-y-2 pr-1">
          {filteredTokens.length > 0 ? (
            <p className="pb-1 text-[11px] uppercase tracking-[0.22em] text-[#8f6e71]">
              {showImportAction ? "Imported tokens" : "Available tokens"}
            </p>
          ) : null}
          {filteredTokens.map((token) => (
            <button
              key={token.isNative ? "native" : token.address}
              type="button"
              onClick={() => onSelect(token)}
              className="flex w-full items-center justify-between rounded-[1rem] border border-[#271012] bg-[#0b0b0b] px-4 py-3 text-left transition hover:border-[#ff4d57]"
            >
              <span>
                <span className="block text-sm font-semibold uppercase tracking-[0.16em] text-white">
                  {token.symbol}
                </span>
                <span className="mt-1 block text-xs text-[#b48a8e]">
                  {token.name}
                </span>
              </span>
              <span className="text-[11px] uppercase tracking-[0.22em] text-[#ff717a]">
                {token.imported ? "Imported" : "Default"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function InfoRow({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="uppercase tracking-[0.22em] text-[#8f6e71]">{label}</span>
      <span className={mono ? "font-mono text-right text-[#f2d8da]" : "text-right text-[#f2d8da]"}>
        {value}
      </span>
    </div>
  );
}

function LinkedInfoRow({
  href,
  label,
  value,
}: {
  href: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="uppercase tracking-[0.22em] text-[#8f6e71]">{label}</span>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 font-mono text-right text-[#f2d8da] transition hover:text-[#ff8b92]"
      >
        <span>{value}</span>
        <ExternalLinkIcon className="h-3.5 w-3.5 text-[#ff646d]" />
      </a>
    </div>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M4 6.25L8 10.25L12 6.25"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M6 3.5H3.75C3.06 3.5 2.5 4.06 2.5 4.75V12.25C2.5 12.94 3.06 13.5 3.75 13.5H11.25C11.94 13.5 12.5 12.94 12.5 12.25V10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.25 3.5H13.5V8.75"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.25 3.75L7 10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SwapDirectionIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M3 5H12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M10 3L12.5 5L10 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 11H4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M6 9L3.5 11L6 13"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditableInfoRow({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="uppercase tracking-[0.22em] text-[#8f6e71]">{label}</label>
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="decimal"
          className="w-20 rounded-full border border-[#7f1f29] bg-[#14090b] px-3 py-1.5 text-right font-mono text-[#f2d8da] shadow-[0_0_0_1px_rgba(255,77,87,0.12)] outline-none transition focus:border-[#ff4d57] focus:shadow-[0_0_0_1px_rgba(255,77,87,0.34),0_0_18px_rgba(255,77,87,0.16)]"
        />
        <span className="font-mono text-[#f2d8da]">%</span>
      </div>
    </div>
  );
}

function Notice({ children, tone }: { children: React.ReactNode; tone: "error" | "info" | "success" }) {
  const classes =
    tone === "error"
      ? "border-[#5a1c22] bg-[#18090b] text-[#ffb9bf]"
      : tone === "success"
        ? "border-[#1d4a32] bg-[#09180f] text-[#a6f0c0]"
        : "border-[#4a3111] bg-[#171007] text-[#ffd59a]";

  return <p className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${classes}`}>{children}</p>;
}

function parseSlippageInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 50) {
    return null;
  }

  return BigInt(Math.round(parsed * 100));
}

function getSlippageError(value: string, bps: bigint | null) {
  if (!value.trim()) {
    return "Enter a slippage percentage.";
  }

  if (bps === null) {
    return "Slippage must be a number between 0 and 50.";
  }

  return null;
}

function getReadableError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Transaction failed.";
}

const buttonClassName =
  "rounded-full border border-[#ff4d57] bg-black/70 px-3 py-2 text-sm font-medium text-[#ff4d57] transition hover:bg-[#18080b]";

function createSwapDeadline() {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
}
