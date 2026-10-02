import { PermissionGuard } from './permission-guard';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';

/**
 * The two role fences, as allowlists.
 *
 * Both are allowlists for the same reason: the tool registry grows, and a denylist would
 * silently grant every tool added after it was written. These tests exist so that adding a
 * tool cannot quietly widen what a customer or a client can reach.
 */
describe('the Tijarah client fence', () => {
  /**
   * A client is the Tijarah deployment's own role, and the fence is an allowlist for the
   * same reason the customer one is: the registry grows, and a denylist would silently grant
   * every tool added after it was written.
   */
  it('allows the Tijarah set', () => {
    for (const tool of [
      'RequestAccountingReport',
      'ListAccountingReports',
      'ComposeDocument',
      'SubmitDraftForApproval',
      'ReviewDraft',
      'CancelDraft',
    ]) {
      expect(PermissionGuard.isClientAllowed(tool)).toBe(true);
    }
  });

  it('refuses anything that reaches another number or another person', () => {
    for (const tool of ['MessageSendText', 'AgentSearchContacts', 'SessionFindOne', 'LedgerListOverdue']) {
      expect(PermissionGuard.isClientAllowed(tool)).toBe(false);
    }
  });

  it('refuses the receivables self-service tools, which read a different ledger', () => {
    // "What you owe this business" is not "my own company's books".
    for (const tool of ['AgentSelfBalance', 'AgentSelfStatement', 'AgentSelfInvoice']) {
      expect(PermissionGuard.isClientAllowed(tool)).toBe(false);
    }
  });

  it('ranks a client as OPERATOR, because the Tijarah tools are declared at that tier', () => {
    expect(PermissionGuard.apiRoleFor('client')).toBe(ApiKeyRole.OPERATOR);
  });
});

describe('the receivables customer fence', () => {
  it('allows a customer only their own account', () => {
    for (const tool of ['AgentSelfBalance', 'AgentSelfStatement', 'AgentSelfInvoice', 'AgentOptOut']) {
      expect(PermissionGuard.isCustomerAllowed(tool)).toBe(true);
    }
  });

  it('refuses a customer the operator tools', () => {
    for (const tool of ['MessageSendText', 'AgentSearchContacts', 'RequestAccountingReport']) {
      expect(PermissionGuard.isCustomerAllowed(tool)).toBe(false);
    }
  });

  it('keeps the two fences distinct — a client is not a customer and vice versa', () => {
    // A client reads their own company's books; a customer reads what they owe a business.
    expect(PermissionGuard.isClientAllowed('AgentSelfBalance')).toBe(false);
    expect(PermissionGuard.isCustomerAllowed('RequestAccountingReport')).toBe(false);
  });

  it('ranks customers and strangers at the lowest tier', () => {
    expect(PermissionGuard.apiRoleFor('customer')).toBe(ApiKeyRole.VIEWER);
    expect(PermissionGuard.apiRoleFor('unknown')).toBe(ApiKeyRole.VIEWER);
  });
});
