import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';

const RECENTLY_VIEWED_KEY = 'crowdpay_recently_viewed_campaigns';
const MAX_RECENTLY_VIEWED = 10;

export function addRecentlyViewed(campaignId) {
  if (!campaignId) return;
  try {
    const raw = localStorage.getItem(RECENTLY_VIEWED_KEY);
    const existing = raw ? JSON.parse(raw) : [];
    const next = [campaignId, ...existing.filter((id) => id !== campaignId)].slice(
      0,
      MAX_RECENTLY_VIEWED
    );
    localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(next));
  } catch {
    // Ignore localStorage errors
  }
}

export function useCampaignData({
  id,
  currentLocale = 'en',
  refParam = null,
  token = null,
  user = null,
  contributed = 0,
  isLive = false,
  showAll = false,
}) {
  const [campaign, setCampaign] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [milestones, setMilestones] = useState([]);
  const [milestonesLoading, setMilestonesLoading] = useState(false);
  const [stretchGoals, setStretchGoals] = useState([]);
  const [tiers, setTiers] = useState([]);
  const [nftRewards, setNftRewards] = useState([]);
  const [contributions, setContributions] = useState([]);
  const [totalContributions, setTotalContributions] = useState(0);
  const [activeDispute, setActiveDispute] = useState(null);
  const [contractStatus, setContractStatus] = useState(null);
  const [contractStatusError, setContractStatusError] = useState('');
  const [hasPendingWithdrawal, setHasPendingWithdrawal] = useState(false);
  const pollingRef = useRef({ intervalId: null, aborted: false });

  // Main campaign fetch
  const fetchCampaign = useCallback(async () => {
    if (!id) return;
    setLoadError('');
    try {
      const opts = {
        locale: currentLocale,
        ...(refParam ? { ref: refParam } : {}),
      };
      const data = await api.getCampaign(id, opts);
      setCampaign(data);
      addRecentlyViewed(data.id);
      return data;
    } catch (err) {
      setLoadError(err.message || 'Could not load campaign.');
      throw err;
    }
  }, [id, currentLocale, refParam]);

  useEffect(() => {
    fetchCampaign().catch(() => {});
  }, [fetchCampaign, contributed]);

  // Load milestones, stretch goals, tiers, nft rewards, contract status, withdrawals
  useEffect(() => {
    if (!id) return;
    setMilestonesLoading(true);

    api
      .getMilestones(id, { locale: currentLocale })
      .then(setMilestones)
      .catch(() => setMilestones([]))
      .finally(() => setMilestonesLoading(false));

    api
      .getStretchGoals(id)
      .then(setStretchGoals)
      .catch(() => setStretchGoals([]));

    api
      .getContractStatus(id)
      .then((data) => {
        setContractStatus(data);
        setContractStatusError('');
      })
      .catch((err) => {
        setContractStatus(null);
        setContractStatusError(err.message || 'Could not load on-chain status.');
      });

    api
      .getCampaignTiers(id)
      .then((data) => setTiers(Array.isArray(data) ? data : []))
      .catch(() => setTiers([]));

    if (api.getCampaignNftRewards) {
      api
        .getCampaignNftRewards(id)
        .then((data) => setNftRewards(Array.isArray(data?.rewards) ? data.rewards : []))
        .catch(() => setNftRewards([]));
    }

    if (token && api.listWithdrawals) {
      api
        .listWithdrawals(id)
        .then((withdrawals) => {
          const hasPending =
            Array.isArray(withdrawals) && withdrawals.some((w) => w.status === 'pending');
          setHasPendingWithdrawal(hasPending);
        })
        .catch(() => setHasPendingWithdrawal(false));
    }
  }, [id, token, currentLocale, contributed]);

  // Dispute check
  useEffect(() => {
    if (!id || !user || campaign?.status !== 'disputed') {
      setActiveDispute(null);
      return;
    }
    if (api.getCampaignDispute) {
      api
        .getCampaignDispute(id)
        .then((data) => setActiveDispute(data.dispute))
        .catch(() => setActiveDispute(null));
    }
  }, [id, user, campaign?.status]);

  // Contributions check
  useEffect(() => {
    if (!id) return;
    api
      .getContributions(id, { limit: showAll ? 100 : 10, offset: 0 })
      .then((data) => {
        setContributions(data.contributions || []);
        setTotalContributions(data.total || 0);
      })
      .catch(() => {
        setContributions([]);
        setTotalContributions(0);
      });
  }, [id, showAll, contributed]);

  // Polling for live status
  useEffect(() => {
    if (!id || isLive || !campaign) return;

    const isCampaignClosed = [
      'funded',
      'closed',
      'withdrawn',
      'failed',
      'completed',
      'refunded',
    ].includes(campaign.status);
    if (isCampaignClosed) return;

    pollingRef.current.aborted = false;

    const refresh = async () => {
      if (pollingRef.current.aborted) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        const [nextCampaign, nextContributionsData] = await Promise.all([
          api.getCampaign(id),
          api.getContributions(id, { limit: showAll ? 100 : 10, offset: 0 }),
        ]);
        if (pollingRef.current.aborted) return;
        setCampaign(nextCampaign);
        setContributions(nextContributionsData.contributions || []);
        setTotalContributions(nextContributionsData.total || 0);
      } catch {
        // ignore transient polling errors
      }
    };

    const start = () => {
      if (pollingRef.current.intervalId !== null) return;
      refresh();
      pollingRef.current.intervalId = window.setInterval(refresh, 15_000);
    };

    const stop = () => {
      if (pollingRef.current.intervalId === null) return;
      window.clearInterval(pollingRef.current.intervalId);
      pollingRef.current.intervalId = null;
    };

    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') start();
      else stop();
    };

    start();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      pollingRef.current.aborted = true;
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [id, isLive, campaign?.status, showAll]);

  return {
    campaign,
    setCampaign,
    loadError,
    milestones,
    setMilestones,
    milestonesLoading,
    stretchGoals,
    setStretchGoals,
    tiers,
    setTiers,
    nftRewards,
    setNftRewards,
    contributions,
    setContributions,
    totalContributions,
    setTotalContributions,
    activeDispute,
    setActiveDispute,
    contractStatus,
    setContractStatus,
    contractStatusError,
    hasPendingWithdrawal,
    refreshCampaign: fetchCampaign,
  };
}

export default useCampaignData;
