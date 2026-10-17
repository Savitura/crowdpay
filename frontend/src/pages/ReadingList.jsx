import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useToast } from '../context/ToastContext';

export default function ReadingList() {
  const { toast } = useToast();
  const { t } = useTranslation();
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    api
      .getFavorites()
      .then((res) => setCampaigns(res.data || []))
      .catch(() => toast('Failed to load reading list', 'error'))
      .finally(() => setLoading(false));
  }, [toast]);

  const handleRemove = async (campaignId) => {
    try {
      await api.removeFavorite(campaignId);
      setCampaigns((prev) => prev.filter((c) => c.id !== campaignId));
      toast('Removed from reading list', 'info');
    } catch {
      toast('Failed to remove', 'error');
    }
  };

  const filtered = campaigns.filter((c) => {
    const matchSearch =
      !search ||
      c.title?.toLowerCase().includes(search.toLowerCase()) ||
      c.category?.toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === 'all' || c.status === filter;
    return matchSearch && matchFilter;
  });

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('readingList.title')}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {campaigns.length}{' '}
            {t(campaigns.length === 1 ? 'readingList.campaign' : 'readingList.campaigns')}
          </p>
        </div>
        <Link
          to="/discover"
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
        >
          {t('readingList.discoverCampaigns')}
        </Link>
      </div>

      {/* Search and filter */}
      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="text"
          placeholder={t('readingList.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] px-3 py-2 border rounded-lg text-sm"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="px-3 py-2 border rounded-lg text-sm"
        >
          <option value="all">{t('readingList.allStatus')}</option>
          <option value="active">{t('home.statusActive')}</option>
          <option value="funded">{t('home.statusFunded')}</option>
          <option value="in_progress">{t('readingList.statusInProgress')}</option>
          <option value="completed">{t('readingList.statusCompleted')}</option>
        </select>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">{t('common.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          {search ? t('readingList.noMatches') : t('readingList.empty')}
          <br />
          <Link
            to="/discover"
            className="text-indigo-600 hover:text-indigo-800 text-sm font-medium mt-2 inline-block"
          >
            {t('readingList.browseCampaigns')}
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((camp) => {
            const pct = Math.min(100, (camp.raised_amount / camp.target_amount) * 100);
            return (
              <div
                key={camp.id}
                className="bg-white border rounded-lg p-4 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between gap-3">
                  <Link to={`/campaigns/${camp.id}`} className="flex-1 min-w-0">
                    <h3 className="font-semibold text-gray-900 truncate">{camp.title}</h3>
                    {camp.category && (
                      <span className="inline-block mt-1 px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600">
                        {camp.category}
                      </span>
                    )}
                  </Link>
                  <button
                    onClick={() => handleRemove(camp.id)}
                    className="shrink-0 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                    title={t('readingList.removeFromList')}
                  >
                    ✕
                  </button>
                </div>

                <div className="mt-3">
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-gray-500">
                      {Number(camp.raised_amount).toLocaleString()} {t('readingList.raised')}
                    </span>
                    <span className="font-medium text-gray-700">{pct.toFixed(1)}%</span>
                  </div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: pct >= 100 ? '#10b981' : '#2563eb',
                      }}
                    />
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                  <span
                    className={`px-2 py-0.5 rounded-full font-medium ${
                      camp.status === 'active'
                        ? 'bg-green-100 text-green-700'
                        : camp.status === 'funded'
                          ? 'bg-blue-100 text-blue-700'
                          : camp.status === 'completed'
                            ? 'bg-gray-100 text-gray-600'
                            : 'bg-red-100 text-red-600'
                    }`}
                  >
                    {camp.status}
                  </span>
                  <Link
                    to={`/campaigns/${camp.id}`}
                    className="text-indigo-600 hover:text-indigo-800 font-medium"
                  >
                    {t('readingList.view')}
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
