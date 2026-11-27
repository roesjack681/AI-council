import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { call } from '../services/client';
import type { Command } from '../protocols/commands';
import type { Snapshot, VerificationPolicy } from '../protocols/domain';
import { requestModelSiteAccess } from '../services/site-access';

const PRIVACY_KEY = 'ai-council-privacy-ack';
const runningStatuses = new Set([
  'INITIALIZING',
  'INITIAL_ANSWERS',
  'FREE_DISCUSSION',
  'OBJECTION_REVIEW',
  'CONSENSUS_CHECK',
  'FINALIZING',
]);

export const useCouncilStore = defineStore('council', () => {
  const snapshot = ref<Snapshot>({
    browserSessions: [],
    browserDeliveries: [],
    participants: [],
    discussions: [],
    messages: [],
    rounds: [],
    claims: [],
    claimRevisions: [],
    positions: [],
    objections: [],
    consensusRecords: [],
    factChecks: [],
    queue: [],
    logs: [],
    reports: [],
    chatNotices: [],
    brainRequests: [],
  });
  const selectedId = ref('');
  const verificationPolicy = ref<VerificationPolicy>(
    typeof localStorage !== 'undefined' &&
      localStorage.getItem('ai-council-verification-policy') === 'independent_evidence'
      ? 'independent_evidence'
      : 'discussion_only',
  );
  function setVerificationPolicy(value: VerificationPolicy): void {
    verificationPolicy.value = value;
    if (typeof localStorage !== 'undefined')
      localStorage.setItem('ai-council-verification-policy', value);
  }
  const error = ref('');
  const busy = ref(false);
  const page = ref<'chat' | 'settings'>('chat');
  const privacyAcknowledged = ref(
    typeof localStorage !== 'undefined' && localStorage.getItem(PRIVACY_KEY) === '1',
  );
  const selected = computed(() =>
    snapshot.value.discussions.find((d) => d.id === selectedId.value),
  );
  const brainParticipant = computed(() =>
    snapshot.value.participants.find((p) => p.enabled && (p.role ?? 'council') === 'brain'),
  );
  const readyParticipants = computed(() =>
    snapshot.value.participants.filter(
      (p) =>
        p.enabled &&
        (p.role ?? 'council') !== 'brain' &&
        (p.status === 'available' || p.status === 'first_message_ready'),
    ),
  );
  const hasRunningDiscussion = computed(() =>
    snapshot.value.discussions.some((d) => runningStatuses.has(d.status)),
  );
  const activeBrainRequest = computed(() =>
    snapshot.value.brainRequests.find(
      (job) => !['done', 'paused', 'cancelled'].includes(job.phase),
    ),
  );
  const pausedBrainRequests = computed(() =>
    snapshot.value.brainRequests.filter(
      (job) =>
        job.phase === 'paused' &&
        (!snapshot.value.activeRequest || job.id === snapshot.value.activeRequest.brainRequestId) &&
        !['NEW_QUESTION', 'UPGRADE_REVIEW_REQUIRED', 'REQUEST_SUPERSEDED'].includes(
          job.error?.code ?? '',
        ),
    ),
  );
  const pendingRequestId = ref('');
  const canAsk = computed(
    () =>
      privacyAcknowledged.value &&
      !busy.value &&
      (Boolean(brainParticipant.value) ||
        snapshot.value.participants.some((p) => p.enabled && (p.role ?? 'council') !== 'brain')),
  );

  function acknowledgePrivacy(): void {
    privacyAcknowledged.value = true;
    if (typeof localStorage !== 'undefined') localStorage.setItem(PRIVACY_KEY, '1');
  }

  async function refresh(): Promise<void> {
    snapshot.value = (await call({ type: 'snapshot' })) as Snapshot;
    const routed = snapshot.value.brainRequests.find(
      (job) => job.id === (pendingRequestId.value || snapshot.value.activeRequest?.brainRequestId),
    );
    if (routed?.discussionId && (pendingRequestId.value || !selectedId.value)) {
      selectedId.value = routed.discussionId;
      pendingRequestId.value = '';
    }
    if (routed && !routed.discussionId && !['done', 'cancelled'].includes(routed.phase)) {
      selectedId.value = '';
      return;
    }
    if (!selectedId.value || !snapshot.value.discussions.some((d) => d.id === selectedId.value))
      selectedId.value =
        snapshot.value.activeRequest?.discussionId ??
        [...snapshot.value.discussions].sort((a, b) => b.createdAt - a.createdAt)[0]?.id ??
        '';
  }

  async function run(command: Command): Promise<void> {
    busy.value = true;
    error.value = '';
    try {
      if (
        [
          'chat.ask',
          'discussion.start',
          'brain.resume',
          'participant.check',
          'draft.restore',
        ].includes(command.type)
      ) {
        const participants =
          command.type === 'participant.check'
            ? snapshot.value.participants.filter((p) => p.id === command.id)
            : snapshot.value.participants.filter((p) => p.enabled);
        if (!(await requestModelSiteAccess(participants)))
          throw new Error('首次运行需要允许模型网站访问权限。授权后程序会自动检查并准备网页。');
      }
      const data = await call(command);
      if (
        command.type === 'chat.ask' &&
        typeof data === 'object' &&
        data !== null &&
        'requestId' in data &&
        typeof data.requestId === 'string'
      )
        pendingRequestId.value = data.requestId;
      if (
        command.type === 'discussion.create' &&
        typeof data === 'object' &&
        data !== null &&
        'id' in data &&
        typeof data.id === 'string'
      )
        selectedId.value = data.id;
      if (
        command.type === 'chat.ask' &&
        typeof data === 'object' &&
        data !== null &&
        'discussionId' in data &&
        typeof (data as { discussionId?: unknown }).discussionId === 'string'
      )
        selectedId.value = (data as { discussionId: string }).discussionId;
      await refresh();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  async function ask(question: string): Promise<void> {
    const text = question.trim();
    if (!text) return;
    if (!privacyAcknowledged.value) {
      error.value = '请先在设置中确认隐私提示后再提问。';
      page.value = 'settings';
      return;
    }
    if (
      !brainParticipant.value &&
      !snapshot.value.participants.some((p) => p.enabled && (p.role ?? 'council') !== 'brain')
    ) {
      error.value = '请先添加一个参与模型。可点名向单个成员提问，共识讨论需要两名成员。';
      page.value = 'settings';
      return;
    }
    pendingRequestId.value = '';
    selectedId.value = '';
    await run({ type: 'chat.ask', question: text, verificationPolicy: verificationPolicy.value });
  }

  async function resumeSelected(): Promise<void> {
    const id = selectedId.value;
    if (!id) return;
    const d = selected.value;
    if (!d || !['CREATED', 'PAUSED'].includes(d.status)) return;
    await run({ type: 'discussion.start', id });
  }

  let polling = false;
  async function poll(): Promise<void> {
    if (polling || busy.value) return;
    polling = true;
    try {
      if (
        activeBrainRequest.value ||
        snapshot.value.discussions.some((d) => runningStatuses.has(d.status))
      )
        await call({ type: 'tick' });
      await refresh();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      polling = false;
    }
  }

  return {
    snapshot,
    verificationPolicy,
    setVerificationPolicy,
    selectedId,
    selected,
    error,
    busy,
    page,
    privacyAcknowledged,
    brainParticipant,
    readyParticipants,
    hasRunningDiscussion,
    activeBrainRequest,
    pausedBrainRequests,
    canAsk,
    acknowledgePrivacy,
    refresh,
    run,
    ask,
    resumeSelected,
    poll,
  };
});
