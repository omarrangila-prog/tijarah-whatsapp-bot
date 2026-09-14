import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { filtersForView, type InboxView } from './inboxFilters.ts';

describe('filtersForView', () => {
  test('the default view applies no filters', () => {
    assert.deepEqual(filtersForView('all'), {});
  });

  test('"Mine" defers resolution of the current agent to the server', () => {
    // The browser does not know which agent the API key maps to; only the gateway does.
    assert.deepEqual(filtersForView('mine'), { assigneeId: 'me' });
  });

  test('"Unassigned" is a distinct sentinel, not an empty assignee', () => {
    assert.deepEqual(filtersForView('unassigned'), { assigneeId: 'unassigned' });
  });

  test('status views map to the status field, not to a search term', () => {
    assert.deepEqual(filtersForView('waiting'), { status: 'waiting' });
    assert.deepEqual(filtersForView('resolved'), { status: 'resolved' });
  });

  test('unread and starred are boolean flags', () => {
    assert.deepEqual(filtersForView('unread'), { unreadOnly: true });
    assert.deepEqual(filtersForView('starred'), { starredOnly: true });
  });

  test('every view produces a filter object', () => {
    const views: InboxView[] = ['all', 'mine', 'unassigned', 'unread', 'waiting', 'resolved', 'starred'];
    for (const view of views) {
      assert.equal(typeof filtersForView(view), 'object');
    }
  });
});
