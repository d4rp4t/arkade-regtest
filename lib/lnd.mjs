// Shared lncli helpers used by both the Boltz setup and the invoice commands.
//
// Both LND nodes (`lnd` and `boltz-lnd`) run the BTCPay image and keep data at
// the default /root/.lnd, so lncli finds its tls.cert/macaroons without any
// --lnddir override. The `container` arg is kept for call-site clarity.
import { dockerExec } from './proc.mjs';

export function lncliBase(_container) {
  return ['lncli', '--network=regtest'];
}

// Run an lncli command in a container. Returns { ok, json, raw, err }:
// ok=false on a non-zero exit; json is the parsed output when it is valid JSON,
// otherwise raw holds the plain stdout.
export function lncli(container, args) {
  const r = dockerExec(container, [...lncliBase(container), ...args], { capture: true });
  if (r.code !== 0) return { ok: false, json: null, err: r.stderr || r.stdout };
  try {
    return { ok: true, json: JSON.parse(r.stdout) };
  } catch {
    return { ok: true, json: null, raw: r.stdout };
  }
}
