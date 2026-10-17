import { useState } from 'react';
import { api } from '../services/api';

const LANGUAGES = [
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' },
  { code: 'hi', label: 'हिन्दी' },
];

export default function TranslationManager({ campaignId }) {
  const [selectedLang, setSelectedLang] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const handleSave = async () => {
    if (!selectedLang || !title.trim()) {
      setMessage({ type: 'error', text: 'Language and title are required' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await api.upsertTranslation(campaignId, selectedLang, title.trim(), description.trim());
      setMessage({ type: 'success', text: 'Translation saved!' });
      setTitle('');
      setDescription('');
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Failed to save translation' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-50 rounded-lg p-4 space-y-3">
      <h4 className="font-semibold text-gray-900 text-sm">Translations</h4>
      <p className="text-xs text-gray-500">Add campaign descriptions in additional languages.</p>

      <select
        value={selectedLang}
        onChange={(e) => setSelectedLang(e.target.value)}
        className="w-full px-3 py-2 border rounded-lg text-sm"
      >
        <option value="">Select a language...</option>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label} ({l.code})
          </option>
        ))}
      </select>

      <input
        type="text"
        placeholder="Translated title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full px-3 py-2 border rounded-lg text-sm"
        maxLength={255}
      />

      <textarea
        placeholder="Translated description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="w-full px-3 py-2 border rounded-lg text-sm"
        rows={4}
      />

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save Translation'}
      </button>

      {message && (
        <p className={`text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-600'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
