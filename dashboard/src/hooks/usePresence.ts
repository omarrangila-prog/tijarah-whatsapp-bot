import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceApi, type AgentPresence, type ConversationViewer } from '../services/commandCenter';

/** How often the agent reports in. Two missed beats drop them from the roster server-side. */
const HEARTBEAT_MS = 20_000;

/** Typing is re-asserted at this cadence while keys are being pressed, and decays on its own. */
const TYPING_ASSERT_MS = 4_000;

export interface PresenceState {
  /** Everyone currently online, ordered by name so the strip does not reshuffle. */
  online: AgentPresence[];
  /** Other agents viewing the SAME conversation you have open. Never includes you. */
  viewers: ConversationViewer[];
  /** Announce that the agent is actively typing; safe to call on every keystroke. */
  noteTyping: () => void;
}

/**
 * Live agent presence for a shared inbox.
 *
 * One heartbeat every 20 seconds carries both "I am here" and "this is what I have open", and the
 * response brings back the roster and the other viewers of that conversation — so the presence
 * strip and the collision warning both stay current on a single round trip per agent. At a hundred
 * agents that is five requests a second across the whole workspace, which is why this is a beat
 * rather than a socket write per keystroke.
 *
 * `agent.presence` and `conversation.viewers` also arrive over the existing `/events` socket, so
 * another agent opening a conversation shows up immediately rather than on your next beat; the
 * heartbeat is what keeps the server's picture true and what expires people who close their laptop.
 */
export function usePresence(conversationId: string | null, enabled: boolean): PresenceState {
  const [online, setOnline] = useState<AgentPresence[]>([]);
  const [viewers, setViewers] = useState<ConversationViewer[]>([]);

  // Read inside the interval so a conversation change is picked up by the next beat without
  // tearing down and re-creating the timer on every selection. Written in an effect, never during
  // render: React may render without committing, and a ref updated in a discarded pass would report
  // the agent as viewing a conversation they never opened.
  const conversationRef = useRef<string | null>(conversationId);
  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId]);
  const typingUntilRef = useRef(0);

  const noteTyping = useCallback(() => {
    typingUntilRef.current = Date.now() + TYPING_ASSERT_MS;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const beat = async () => {
      try {
        const result = await workspaceApi.heartbeat({
          viewingConversationId: conversationRef.current,
          typing: Date.now() < typingUntilRef.current,
        });
        if (cancelled) return;
        setOnline(result.online);
        setViewers(result.viewers);
      } catch {
        // Presence is a convenience layer. A failed beat must never surface as an error in an inbox
        // that is otherwise working — the agent simply ages out of the roster and reappears on the
        // next successful call.
      }
    };

    void beat();
    const timer = window.setInterval(() => void beat(), HEARTBEAT_MS);

    // Beat immediately when the operator comes back to the tab, so someone returning from lunch is
    // routable again at once rather than up to twenty seconds later.
    const onFocus = () => void beat();
    window.addEventListener('focus', onFocus);

    // Leave the roster on close. `sendBeacon` is not used because the endpoint needs the API-key
    // header, which beacons cannot carry; keepalive on fetch gives the same "survives unload"
    // behaviour and does carry headers.
    const onUnload = () => {
      void workspaceApi.leavePresence().catch(() => undefined);
    };
    window.addEventListener('pagehide', onUnload);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onUnload);
    };
  }, [enabled]);

  // A conversation change should reflect immediately rather than waiting for the next beat —
  // otherwise a teammate sees you "in" a conversation you already left.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void workspaceApi
      .heartbeat({ viewingConversationId: conversationId, typing: false })
      .then(result => {
        if (cancelled) return;
        setOnline(result.online);
        setViewers(result.viewers);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId, enabled]);

  return { online, viewers, noteTyping };
}
