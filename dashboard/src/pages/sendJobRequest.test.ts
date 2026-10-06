import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSendJob, canSend, needsDocumentNumber, type SendFormValues } from './sendJobRequest.ts';

const saleInvoice = {
  documentType: 'sale_invoice',
  displayName: 'Sale Invoice',
  requiredParameters: ['documentNumber'],
  optionalParameters: [],
};
const customerLedger = {
  documentType: 'customer_ledger',
  displayName: 'Customer Ledger',
  requiredParameters: [],
  optionalParameters: ['from', 'to', 'partyCode'],
};
const blankTenant = { sid: '', grp: '', aYear: '' };

function form(overrides: Partial<SendFormValues>): SendFormValues {
  return {
    type: saleInvoice,
    documentNumber: '',
    from: '',
    to: '',
    partyCode: '',
    tenant: blankTenant,
    number: '',
    recipientName: '',
    messageText: '',
    ...overrides,
  };
}

const NOW = new Date('2026-10-06T17:30:45Z');

test('an invoice is asked for by its number, from the chosen client’s company', () => {
  const job = buildSendJob(
    form({
      documentNumber: ' 179 ',
      tenant: { sid: '1006', grp: 'GR', aYear: '2026' },
      number: '923302417530',
      recipientName: 'Hafiz Usman',
    }),
    NOW,
  );
  assert.deepEqual(job.parameters, { documentNumber: '179', companyId: '1006', branch: 'GR', year: '2026' });
  assert.equal(job.documentReference, '179');
  assert.equal(job.clientId, '1006');
  assert.equal(job.recipientName, 'Hafiz Usman');
  assert.equal(job.idempotencyKey, 'ui-1006-sale_invoice-179-923302417530');
});

test('a blank company is left to the type’s defaults rather than sent empty', () => {
  const job = buildSendJob(form({ documentNumber: '179', number: '+92 330 2417530' }), NOW);
  assert.deepEqual(job.parameters, { documentNumber: '179' });
  assert.equal(job.clientId, undefined);
  assert.equal(job.idempotencyKey, 'ui-default-sale_invoice-179-923302417530');
});

test('a blank caption and name are left to the server, which writes the standard caption', () => {
  const job = buildSendJob(form({ documentNumber: '179', number: '923302417530', messageText: '   ' }), NOW);
  assert.equal(job.messageText, undefined);
  assert.equal(job.recipientName, undefined);
});

test('a report carries its period and party, and is keyed to the minute so it can be asked for again', () => {
  const job = buildSendJob(
    form({
      type: customerLedger,
      from: '2026-07-01',
      to: '2026-09-30',
      partyCode: 'C-104',
      tenant: { sid: '1006', grp: 'GR', aYear: '2026' },
      number: '923302417530',
    }),
    NOW,
  );
  assert.deepEqual(job.parameters, {
    companyId: '1006',
    branch: 'GR',
    year: '2026',
    from: '2026-07-01',
    to: '2026-09-30',
    partyCode: 'C-104',
  });
  assert.equal(job.documentReference, 'Customer Ledger');
  assert.equal(job.partyId, 'C-104');
  assert.equal(job.idempotencyKey, 'ui-1006-customer_ledger-C-104-2026-07-01-2026-09-30-2026-10-06T17:30-923302417530');

  const later = buildSendJob(
    form({ type: customerLedger, tenant: { sid: '1006', grp: 'GR', aYear: '2026' }, number: '923302417530' }),
    new Date('2026-10-06T17:31:02Z'),
  );
  assert.notEqual(later.idempotencyKey, job.idempotencyKey);
});

test('a report’s period is not sent for a type that does not take one', () => {
  const job = buildSendJob(form({ documentNumber: '179', from: '2026-01-01', partyCode: 'C-1', number: '923302417530' }), NOW);
  assert.deepEqual(job.parameters, { documentNumber: '179' });
  assert.equal(job.partyId, undefined);
});

test('nothing can be sent until there is a real number and, for a document, its number', () => {
  assert.equal(canSend({ type: saleInvoice, documentNumber: '', number: '923302417530' }), false);
  assert.equal(canSend({ type: saleInvoice, documentNumber: '179', number: '' }), false);
  assert.equal(canSend({ type: saleInvoice, documentNumber: '179', number: '+92 330' }), false);
  assert.equal(canSend({ type: saleInvoice, documentNumber: '179', number: '9233024175301234' }), false);
  assert.equal(canSend({ type: saleInvoice, documentNumber: '179', number: '+92 330 2417530' }), true);
  assert.equal(canSend({ type: customerLedger, documentNumber: '', number: '923302417530' }), true);
});

test('needsDocumentNumber: documents do, reports and unknown types do not', () => {
  assert.equal(needsDocumentNumber(saleInvoice), true);
  assert.equal(needsDocumentNumber(customerLedger), false);
  assert.equal(needsDocumentNumber(undefined), false);
});
