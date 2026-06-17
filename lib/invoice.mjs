// Lightning invoice helpers — ports of helpers/create-invoice.sh and
// helpers/pay-invoice.sh into the cross-platform CLI.
import { log, fail } from './log.mjs';
import { lncli } from './lnd.mjs';

// lncli that aborts on failure and returns the parsed JSON (or raw stdout).
function lncliJson(container, args) {
  const r = lncli(container, args);
  if (!r.ok) fail(`lncli ${args.join(' ')} on ${container} failed: ${r.err}`);
  return r.json ?? r.raw;
}

// Create a 100k-sat invoice on boltz-lnd (primary) or lnd (--secondary).
// Prints the bare payment request to stdout so it can be piped/captured.
export function createInvoice({ secondary = false } = {}) {
  const container = secondary ? 'lnd' : 'boltz-lnd';
  log(`Creating invoice on ${secondary ? 'secondary (lnd)' : 'primary (boltz-lnd)'} ...`);
  const { payment_request: invoice } = lncliJson(container, ['addinvoice', '--amt', '100000']);
  log('Invoice created');
  console.log(invoice);
  return invoice;
}

// Pay an invoice from whichever node is NOT its destination.
export function payInvoice(invoice) {
  if (!invoice) fail('usage: node regtest.mjs pay-invoice <invoice>');
  const dest = lncliJson('boltz-lnd', ['decodepayreq', invoice]).destination;
  const primary = lncliJson('boltz-lnd', ['getinfo']).identity_pubkey;
  const secondary = lncliJson('lnd', ['getinfo']).identity_pubkey;

  if (dest === primary) {
    log('Paying invoice from secondary (lnd) -> primary (boltz-lnd)...');
    lncliJson('lnd', ['payinvoice', '--force', invoice]);
  } else if (dest === secondary) {
    log('Paying invoice from primary (boltz-lnd) -> secondary (lnd)...');
    lncliJson('boltz-lnd', ['payinvoice', '--force', invoice]);
  } else {
    fail('Invoice destination matches neither boltz-lnd nor lnd');
  }
}
