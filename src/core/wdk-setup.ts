import WDK from '@tetherto/wdk';
import AaveProtocol from '@tetherto/wdk-protocol-lending-aave-evm';
import VeloraProtocol from '@tetherto/wdk-protocol-swap-velora-evm';
import Usdt0Protocol from '@tetherto/wdk-protocol-bridge-usdt0-evm';
import WalletManagerEvm from '@tetherto/wdk-wallet-evm';
import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337';
import { getOrCreateUserAccountContext } from './account-context.js';
import { config } from './config.js';

let wdkInstance: InstanceType<typeof WDK> | null = null;
export const OPERATOR_ACCOUNT_INDEX = 0;

export function initWdk(): InstanceType<typeof WDK> {
  if (wdkInstance) return wdkInstance;

  const seed = process.env.WDK_SEED;
  if (!seed) throw new Error('Missing required env var: WDK_SEED');

  wdkInstance = new WDK(seed);

  for (const [chain, chainConfig] of Object.entries(config.chains)) {
    if (config.wdk.useErc4337 && config.wdk.bundlerUrl) {
      // ERC-4337 account abstraction — WDK's crown jewel feature
      // Enables gasless transactions via bundler + Safe smart account
      (wdkInstance as any).registerWallet(chain, WalletManagerEvmErc4337, {
        provider: chainConfig.provider,
        bundlerUrl: config.wdk.bundlerUrl,
        chainId: (chainConfig as { chainId?: number }).chainId ?? 42161,
      });
      console.log(`[WDK] ERC-4337 wallet registered for chain: ${chain}`);
    } else {
      // Standard EOA wallet
      wdkInstance.registerWallet(chain, WalletManagerEvm, {
        provider: chainConfig.provider,
      });
      console.log(`[WDK] Standard EVM wallet registered for chain: ${chain}`);
    }

    // Cast needed: WDK beta types expect 4 args but 3 works at runtime
    (wdkInstance as any).registerProtocol(chain, 'velora', VeloraProtocol);
    (wdkInstance as any).registerProtocol(chain, 'aave', AaveProtocol);
    (wdkInstance as any).registerProtocol(chain, 'usdt0', Usdt0Protocol);
  }

  return wdkInstance;
}

export function getWdk(): InstanceType<typeof WDK> {
  if (!wdkInstance) throw new Error('WDK not initialized. Call initWdk() first.');
  return wdkInstance;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAccount(
  chain: string = 'ethereum',
  opts: number | { index?: number; userId?: string } = 0,
): Promise<any> {
  const wdk = getWdk();

  if (typeof opts === 'number') {
    return wdk.getAccount(chain, opts);
  }

  const index = opts.index ?? (
    opts.userId
      ? getOrCreateUserAccountContext(opts.userId, chain).accountIndex
      : 0
  );

  return wdk.getAccount(chain, index);
}

// Explicit service/operator wallet accessor for system-owned flows.
// Keep this separate from user-scoped resolution so call sites reveal intent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getOperatorAccount(chain: string = 'ethereum'): Promise<any> {
  return getAccount(chain, OPERATOR_ACCOUNT_INDEX);
}

export function isErc4337Mode(): boolean {
  return config.wdk.useErc4337 && !!config.wdk.bundlerUrl;
}

export function disposeWdk() {
  if (wdkInstance) {
    wdkInstance.dispose();
    wdkInstance = null;
  }
}
