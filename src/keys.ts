import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory, ECPairInterface } from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import { config } from './config';

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

export { ECPair };

// WIFs are stored testnet-encoded (as in the spike). Addresses for each mode
// are derived from the pubkey under that mode's network parameters: regtest
// gives bcrt1 addresses, signet gives tb1 addresses, same keys throughout.
export function keyFromWif(wif: string): ECPairInterface {
  return ECPair.fromWIF(wif, bitcoin.networks.testnet);
}

export function networkFor(mode: 'regtest' | 'signet'): bitcoin.Network {
  return mode === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet;
}

export function addressOf(key: ECPairInterface, mode: 'regtest' | 'signet'): string {
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: key.publicKey as Buffer,
    network: networkFor(mode),
  });
  if (!address) throw new Error('could not derive address');
  return address;
}

export function scriptOf(key: ECPairInterface, mode: 'regtest' | 'signet'): Buffer {
  const out = bitcoin.payments.p2wpkh({
    pubkey: key.publicKey as Buffer,
    network: networkFor(mode),
  }).output;
  if (!out) throw new Error('could not derive script');
  return Buffer.from(out);
}

export interface DemoKeys {
  vault: ECPairInterface;
  recovery: ECPairInterface;
  decoy: ECPairInterface;
  vaultAddress: string;
  recoveryAddress: string;
  decoyAddress: string;
}

export function loadKeys(): DemoKeys {
  const mode = config.chainMode;
  const vault = keyFromWif(config.vaultWif);
  const recovery = keyFromWif(config.recoveryWif);
  const decoy = keyFromWif(config.decoyWif);
  return {
    vault,
    recovery,
    decoy,
    vaultAddress: addressOf(vault, mode),
    recoveryAddress: addressOf(recovery, mode),
    decoyAddress: addressOf(decoy, mode),
  };
}
