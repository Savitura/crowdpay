import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

export function useCampaignComments({ campaignId, user = null }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchComments = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    setError('');
    try {
      if (api.getComments) {
        const data = await api.getComments(campaignId);
        setComments(Array.isArray(data) ? data : data?.comments || []);
      }
    } catch (err) {
      setError(err.message || 'Could not load comments.');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  const postComment = async (text) => {
    if (!campaignId || !text?.trim()) return;
    try {
      if (api.postComment) {
        const newComment = await api.postComment(campaignId, { text });
        setComments((prev) => [newComment, ...prev]);
        return newComment;
      }
    } catch (err) {
      setError(err.message || 'Could not post comment.');
      throw err;
    }
  };

  const deleteComment = async (commentId) => {
    if (!campaignId || !commentId) return;
    try {
      if (api.deleteComment) {
        await api.deleteComment(campaignId, commentId);
        setComments((prev) => prev.filter((c) => c.id !== commentId));
      }
    } catch (err) {
      setError(err.message || 'Could not delete comment.');
      throw err;
    }
  };

  return {
    comments,
    setComments,
    loading,
    error,
    postComment,
    deleteComment,
    reloadComments: fetchComments,
  };
}

export default useCampaignComments;
