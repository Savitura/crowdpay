import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';

const MAX_COMPARE = 4;

const CATEGORY_COLORS = {
  technology: '#7c3aed',
  community: '#059669',
  arts: '#db2777',
  education: '#2563eb',
  environment: '#0d9488',
  health: '#dc2626',
  business: '#d97706',
  open_source: '#0891b2',
  startup: '#7c3aed',
  other: '#6b7280',
};

function daysLeft(deadline) {
  if (!deadline) return 'No deadline';
  const diff = Math.ceil((new Date(deadline) - Date.now()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return 'Ended';
  if (diff === 0) return 'Last day';
  return `${diff} day${diff !== 1 ? 's' : ''} left`;
}

export default function CampaignCompare() {
  const { t } = useTranslation();
  const [allCampaigns, setAllCampaigns] = useState([]);
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showSelector, setShowSelector] = useState(false);
  const [sortBy, setSortBy] = useState('progress');

  useEffect(() => {
    api
      .getCampaigns({ limit: 50 })
      .then((res) => setAllCampaigns(res.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleAddCampaign = useCallback(
    (camp) => {
      if (selected.length >= MAX_COMPARE) return;
      if (selected.some((s) => s.id === camp.id)) return;
      setSelected((prev) => [...prev, camp]);
      setShowSelector(false);
      setSearch('');
    },
    [selected]
  );

  const handleRemove = useCallback((id) => {
    setSelected((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const filtered = allCampaigns.filter(
    (c) =>
      !selected.some((s) => s.id === c.id) &&
      (c.title?.toLowerCase().includes(search.toLowerCase()) ||
        c.category?.toLowerCase().includes(search.toLowerCase()))
  );

  const sorted = [...selected].sort((a, b) => {
    switch (sortBy) {
      case 'progress':
        return b.raised_amount / b.target_amount - a.raised_amount / a.target_amount;
      case 'raised':
        return b.raised_amount - a.raised_amount;
      case 'target':
        return b.target_amount - a.target_amount;
      case 'name':
        return (a.title || '').localeCompare(b.title || '');
      default:
        return 0;
    }
  });

  const totalWidth = Math.min(selected.length, MAX_COMPARE);
  const colWidth = totalWidth > 0 ? `${100 / totalWidth}%` : '100%';

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Compare Campaigns</h1>
          <p className="text-sm text-gray-500 mt-1">
            Side-by-side comparison of up to {MAX_COMPARE} campaigns
          </p>
        </div>
        <button
          onClick={() => setShowSelector(true)}
          disabled={selected.length >= MAX_COMPARE}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {selected.length >= MAX_COMPARE ? 'Max 4 campaigns' : 'Add Campaign'}
        </button>
      </div>

      {/* Campaign Selector Dropdown */}
      {showSelector && (
        <div className="mb-6 bg-white border rounded-lg shadow-lg p-4">
          <input
            type="text"
            placeholder="Search campaigns..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm mb-3"
            autoFocus
          />
          <div className="max-h-60 overflow-y-auto space-y-1">
            {filtered.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No matching campaigns</p>
            ) : (
              filtered.slice(0, 20).map((camp) => (
                <button
                  key={camp.id}
                  onClick={() => handleAddCampaign(camp)}
                  className="w-full text-left px-3 py-2 hover:bg-indigo-50 rounded text-sm flex items-center justify-between"
                >
                  <span className="font-medium text-gray-900 truncate mr-2">{camp.title}</span>
                  <span className="text-xs text-gray-400 shrink-0">
                    {Number(camp.raised_amount).toLocaleString()} /{' '}
                    {Number(camp.target_amount).toLocaleString()}
                  </span>
                </button>
              ))
            )}
          </div>
          <button
            onClick={() => {
              setShowSelector(false);
              setSearch('');
            }}
            className="mt-2 text-sm text-gray-500 hover:text-gray-700"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Comparison Table */}
      {selected.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">Select campaigns to compare</p>
          <p className="text-sm mt-1">Click &ldquo;Add Campaign&rdquo; above to get started</p>
        </div>
      ) : (
        <>
          {/* Sort controls */}
          <div className="mb-4 flex items-center gap-2 text-sm text-gray-500">
            <span>Sort by:</span>
            {['progress', 'raised', 'target', 'name'].map((opt) => (
              <button
                key={opt}
                onClick={() => setSortBy(opt)}
                className={`px-2 py-1 rounded ${sortBy === opt ? 'bg-indigo-100 text-indigo-700 font-medium' : 'hover:bg-gray-100'}`}
              >
                {opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="w-40 text-left text-sm font-medium text-gray-500 pb-3 pr-4">
                    Metric
                  </th>
                  {sorted.map((camp) => (
                    <th key={camp.id} style={{ width: colWidth }} className="text-left pb-3 px-2">
                      <Link
                        to={`/campaigns/${camp.id}`}
                        className="text-indigo-600 hover:text-indigo-800 font-semibold text-sm"
                      >
                        {camp.title}
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <tr>
                  <td className="text-sm text-gray-500 py-3 pr-4 font-medium">Category</td>
                  {sorted.map((camp) => (
                    <td key={camp.id} className="py-3 px-2">
                      <span
                        className="inline-block px-2 py-0.5 rounded text-xs font-medium text-white"
                        style={{ backgroundColor: CATEGORY_COLORS[camp.category] || '#6b7280' }}
                      >
                        {camp.category || 'Other'}
                      </span>
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="text-sm text-gray-500 py-3 pr-4 font-medium">Target</td>
                  {sorted.map((camp) => (
                    <td key={camp.id} className="py-3 px-2 text-sm font-semibold">
                      {Number(camp.target_amount).toLocaleString()}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="text-sm text-gray-500 py-3 pr-4 font-medium">Raised</td>
                  {sorted.map((camp) => (
                    <td key={camp.id} className="py-3 px-2 text-sm font-semibold text-green-600">
                      {Number(camp.raised_amount).toLocaleString()}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="text-sm text-gray-500 py-3 pr-4 font-medium">Progress</td>
                  {sorted.map((camp) => {
                    const pct = Math.min(100, (camp.raised_amount / camp.target_amount) * 100);
                    return (
                      <td key={camp.id} className="py-3 px-2">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: pct >= 100 ? '#10b981' : '#2563eb',
                              }}
                            />
                          </div>
                          <span className="text-xs font-medium text-gray-600">
                            {pct.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                    );
                  })}
                </tr>

                <tr>
                  <td className="text-sm text-gray-500 py-3 pr-4 font-medium">Days Left</td>
                  {sorted.map((camp) => (
                    <td key={camp.id} className="py-3 px-2 text-sm">
                      {daysLeft(camp.deadline)}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="text-sm text-gray-500 py-3 pr-4 font-medium">Status</td>
                  {sorted.map((camp) => (
                    <td key={camp.id} className="py-3 px-2">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          camp.status === 'active'
                            ? 'bg-green-100 text-green-800'
                            : camp.status === 'funded'
                              ? 'bg-blue-100 text-blue-800'
                              : camp.status === 'closed'
                                ? 'bg-gray-100 text-gray-600'
                                : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {camp.status}
                      </span>
                    </td>
                  ))}
                </tr>

                <tr>
                  <td className="text-sm text-gray-500 py-3 pr-4 font-medium">Actions</td>
                  {sorted.map((camp) => (
                    <td key={camp.id} className="py-3 px-2">
                      <div className="flex gap-1">
                        <Link
                          to={`/campaigns/${camp.id}`}
                          className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                        >
                          View
                        </Link>
                        <button
                          onClick={() => handleRemove(camp.id)}
                          className="px-2 py-1 text-xs bg-red-50 text-red-600 rounded hover:bg-red-100"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
