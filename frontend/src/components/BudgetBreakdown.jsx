import { useState, useEffect } from 'react';
import { api } from '../services/api';

export default function BudgetBreakdown({ campaignId, targetAmount, disabled }) {
  const [budgets, setBudgets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (!campaignId) return;
    api.getCampaignBudgets(campaignId)
      .then(res => {
        setBudgets(res.length ? res : [{ title: '', amount: '', description: '' }]);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [campaignId]);

  const totalBudget = budgets.reduce((sum, b) => sum + Number(b.amount || 0), 0);
  const isMatch = Math.abs(totalBudget - Number(targetAmount || 0)) < 0.0001;

  const handleAdd = () => {
    setBudgets([...budgets, { title: '', amount: '', description: '' }]);
  };

  const handleRemove = (index) => {
    setBudgets(budgets.filter((_, i) => i !== index));
  };

  const handleChange = (index, field, value) => {
    const newBudgets = [...budgets];
    newBudgets[index][field] = value;
    setBudgets(newBudgets);
  };

  const handleSave = async () => {
    setError('');
    setSuccess('');
    
    if (!isMatch) {
      setError(`Total budget (${totalBudget}) must match the campaign target amount (${targetAmount})`);
      return;
    }

    setSaving(true);
    try {
      await api.saveCampaignBudgets(campaignId, budgets);
      setSuccess('Budget breakdown saved successfully');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div>Loading budgets...</div>;

  return (
    <div className="campaign-card" style={{ marginTop: '2rem' }}>
      <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>Budget Breakdown</h2>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
        Define categorized budget lines that sum exactly to your campaign target amount ({targetAmount}).
      </p>

      {error && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{error}</p>}
      {success && <p className="alert alert--success" style={{ marginBottom: '1rem' }}>{success}</p>}

      <div style={{ display: 'grid', gap: '1rem', marginBottom: '1rem' }}>
        {budgets.map((budget, idx) => (
          <div key={idx} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
            <input 
              type="text" 
              placeholder="Category (e.g., Equipment)" 
              value={budget.title} 
              onChange={e => handleChange(idx, 'title', e.target.value)}
              disabled={disabled}
              style={{ flex: 1 }}
            />
            <input 
              type="number" 
              placeholder="Amount" 
              value={budget.amount} 
              onChange={e => handleChange(idx, 'amount', e.target.value)}
              disabled={disabled}
              style={{ width: '120px' }}
            />
            <button 
              className="btn-secondary" 
              onClick={() => handleRemove(idx)}
              disabled={disabled}
              title="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="btn-secondary" onClick={handleAdd} disabled={disabled}>+ Add Item</button>
        <div style={{ fontWeight: 600, color: isMatch ? 'var(--color-success)' : 'var(--color-error)' }}>
          Total: {totalBudget} / {targetAmount}
        </div>
      </div>

      <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end' }}>
        <button 
          className="btn-primary" 
          onClick={handleSave} 
          disabled={disabled || saving || !isMatch}
        >
          {saving ? 'Saving...' : 'Save Budget'}
        </button>
      </div>
    </div>
  );
}
