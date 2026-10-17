import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

// Operator view of governance synchronization runs (#839): filterable,
// paginated history, run detail, a manual trigger and retry for failed runs.

const PAGE_SIZE = 20;
const STATUS_FILTERS = ['', 'running', 'succeeded', 'failed'];
const TRIGGER_FILTERS = ['', 'scheduled', 'manual', 'retry'];

const STATUS_STYLES = {
  succeeded: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  running: 'bg-blue-100 text-blue-800',
};

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

function duration(run) {
  if (!run.finished_at) return 'in progress';
  const ms = new Date(run.finished_at) - new Date(run.started_at);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function actionMessage(err, fallback) {
  if (err?.status === 409) return 'A governance sync is already running. Wait for it to finish.';
  if (err?.status === 403) return 'Only operators can manage governance sync runs.';
  if (err?.status === 502) return 'The sync run failed. See its error summary below.';
  return err?.message || fallback;
}

function RunDetail({ runId, onRetried, onClose }) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setError('');
    api
      .getGovernanceSyncRun(runId)
      .then((data) => !cancelled && setRun(data))
      .catch((err) => !cancelled && setError(actionMessage(err, 'Could not load this run')));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  async function retry() {
    setRetrying(true);
    setError('');
    try {
      await api.retryGovernanceSyncRun(runId);
      onRetried();
    } catch (err) {
      setError(actionMessage(err, 'Could not retry this run'));
      onRetried();
    } finally {
      setRetrying(false);
    }
  }

  if (error) return <p className="mt-4 text-sm text-red-700">{error}</p>;
  if (!run) return <p className="mt-4 text-sm text-gray-500">Loading run…</p>;

  const canRetry = run.status === 'failed' && !run.retries?.length;

  return (
    <div className="mt-4 rounded border border-gray-200 p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-gray-900">Run {run.id.slice(0, 8)}</h3>
        <button type="button" className="text-gray-500 hover:text-gray-800" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <dt className="text-gray-500">Trigger</dt>
        <dd>{run.trigger}</dd>
        <dt className="text-gray-500">Status</dt>
        <dd>{run.status}</dd>
        <dt className="text-gray-500">Started</dt>
        <dd>{formatTime(run.started_at)}</dd>
        <dt className="text-gray-500">Finished</dt>
        <dd>{formatTime(run.finished_at)}</dd>
        <dt className="text-gray-500">Proposals seen</dt>
        <dd>{run.proposals_seen}</dd>
        <dt className="text-gray-500">Updated</dt>
        <dd>{run.proposals_updated}</dd>
        <dt className="text-gray-500">Not in database</dt>
        <dd>{run.proposals_missing}</dd>
        <dt className="text-gray-500">Provider cursor</dt>
        <dd className="break-all">{run.provider_cursor || '—'}</dd>
      </dl>
      {run.retry_of_run_id && (
        <p className="mt-2 text-gray-600">Retry of run {run.retry_of_run_id.slice(0, 8)}.</p>
      )}
      {run.error_code && (
        <p className="mt-2 rounded bg-red-50 p-2 text-red-800">
          <strong>{run.error_code}</strong>
          {run.error_message ? `: ${run.error_message}` : ''}
        </p>
      )}
      {run.retries?.length > 0 && (
        <p className="mt-2 text-gray-600">
          Retried as run {run.retries[0].id.slice(0, 8)} ({run.retries[0].status}).
        </p>
      )}
      {canRetry && (
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          aria-busy={retrying}
          className="mt-3 rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {retrying ? 'Retrying…' : 'Retry run'}
        </button>
      )}
    </div>
  );
}

export default function GovernanceSyncRunsPanel() {
  const [runs, setRuns] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [trigger, setTrigger] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const params = { limit: PAGE_SIZE, offset };
    if (status) params.status = status;
    if (trigger) params.trigger = trigger;
    return api
      .getGovernanceSyncRuns(params)
      .then((page) => {
        setRuns(page.data || []);
        setTotal(page.total || 0);
      })
      .catch((err) => setError(actionMessage(err, 'Could not load sync runs')))
      .finally(() => setLoading(false));
  }, [offset, status, trigger]);

  useEffect(() => {
    load();
  }, [load]);

  async function syncNow() {
    setSyncing(true);
    setNotice('');
    try {
      const result = await api.triggerGovernanceSync();
      setNotice(result.success ? 'Sync finished.' : 'Sync failed. See the run history.');
    } catch (err) {
      setNotice(actionMessage(err, 'Could not start a sync'));
    } finally {
      setSyncing(false);
      setOffset(0);
      load();
    }
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mt-8 rounded-lg bg-white p-6 shadow">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Sync run history</h2>
          <p className="text-sm text-gray-500">
            Every scheduled, manual and retried synchronization of on-chain proposal state.
          </p>
        </div>
        <button
          type="button"
          onClick={syncNow}
          disabled={syncing}
          aria-busy={syncing}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {notice && <p className="mt-3 text-sm text-gray-700">{notice}</p>}

      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-2">
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
            className="rounded border border-gray-300 px-2 py-1"
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value || 'all'} value={value}>
                {value || 'All'}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Trigger
          <select
            value={trigger}
            onChange={(e) => {
              setTrigger(e.target.value);
              setOffset(0);
            }}
            className="rounded border border-gray-300 px-2 py-1"
          >
            {TRIGGER_FILTERS.map((value) => (
              <option key={value || 'all'} value={value}>
                {value || 'All'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="mt-4 text-sm text-red-700">{error}</p>}

      {loading ? (
        <p className="mt-4 text-sm text-gray-500">Loading runs…</p>
      ) : runs.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">No sync runs match these filters.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Trigger</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Updated</th>
                <th className="px-4 py-2">Duration</th>
                <th className="px-4 py-2">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {runs.map((run) => (
                <tr
                  key={run.id}
                  onClick={() => setSelectedId(run.id)}
                  className={`cursor-pointer hover:bg-gray-50 ${selectedId === run.id ? 'bg-gray-50' : ''}`}
                >
                  <td className="px-4 py-2 whitespace-nowrap">{formatTime(run.started_at)}</td>
                  <td className="px-4 py-2">{run.trigger}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${
                        STATUS_STYLES[run.status] || 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {run.proposals_updated}/{run.proposals_seen}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{duration(run)}</td>
                  <td className="px-4 py-2 text-red-700">{run.error_code || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-sm text-gray-600">
        <span>
          Page {page} of {pages} · {total} run{total === 1 ? '' : 's'}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded border border-gray-300 px-3 py-1 disabled:opacity-50"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded border border-gray-300 px-3 py-1 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>

      {selectedId && (
        <RunDetail
          key={selectedId}
          runId={selectedId}
          onRetried={load}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
