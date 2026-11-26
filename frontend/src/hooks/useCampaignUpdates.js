import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

export const UPDATE_BODY_MAX = 5000;
export const UPDATE_BODY_WARN_THRESHOLD = 4500;

export function useCampaignUpdates({ campaignId, user = null }) {
  const [updates, setUpdates] = useState([]);
  const [updateForm, setUpdateForm] = useState({ title: '', body: '' });
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatesError, setUpdatesError] = useState('');
  const [editingUpdateId, setEditingUpdateId] = useState(null);

  const fetchUpdates = useCallback(async () => {
    if (!campaignId) return;
    try {
      const data = await api.getCampaignUpdates(campaignId, { limit: 20 });
      setUpdates(Array.isArray(data) ? data : []);
    } catch {
      setUpdates([]);
    }
  }, [campaignId]);

  useEffect(() => {
    fetchUpdates();
  }, [fetchUpdates]);

  const submitUpdate = async (e) => {
    if (e) e.preventDefault();
    setUpdatesError('');

    if (updateForm.body.length > UPDATE_BODY_MAX) {
      setUpdatesError(
        `Update body must be ${UPDATE_BODY_MAX} characters or fewer (currently ${updateForm.body.length})`
      );
      return;
    }

    setUpdateBusy(true);

    try {
      if (editingUpdateId) {
        const updated = await api.updateCampaignUpdate(campaignId, editingUpdateId, {
          title: updateForm.title.trim(),
          body: updateForm.body.trim(),
        });

        setUpdates((prev) => prev.map((item) => (item.id === editingUpdateId ? updated : item)));
        setEditingUpdateId(null);
      } else {
        const created = await api.postCampaignUpdate(campaignId, {
          title: updateForm.title.trim(),
          body: updateForm.body.trim(),
        });

        setUpdates((prev) => [created, ...prev]);
      }

      setUpdateForm({ title: '', body: '' });
    } catch (err) {
      setUpdatesError(err.message || 'Could not save update');
    } finally {
      setUpdateBusy(false);
    }
  };

  const deleteUpdate = async (updateId) => {
    if (!window.confirm('Delete this campaign update?')) return;

    setUpdatesError('');
    try {
      await api.deleteCampaignUpdate(campaignId, updateId);
      setUpdates((prev) => prev.filter((item) => item.id !== updateId));
    } catch (err) {
      setUpdatesError(err.message || 'Could not delete update');
    }
  };

  const startEditUpdate = (item) => {
    setEditingUpdateId(item.id);
    setUpdateForm({ title: item.title, body: item.body });
  };

  const cancelEditUpdate = () => {
    setEditingUpdateId(null);
    setUpdateForm({ title: '', body: '' });
  };

  return {
    updates,
    setUpdates,
    updateForm,
    setUpdateForm,
    updateBusy,
    updatesError,
    editingUpdateId,
    setEditingUpdateId,
    submitUpdate,
    deleteUpdate,
    startEditUpdate,
    cancelEditUpdate,
    reloadUpdates: fetchUpdates,
  };
}

export default useCampaignUpdates;
