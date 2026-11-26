import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';

const CATEGORY_LABELS = {
  all: 'All Documents',
  pitch_deck: 'Pitch Deck',
  financials: 'Financials',
  legal: 'Legal & Contracts',
  technical: 'Technical & Architecture',
  diligence: 'Due Diligence',
  governance: 'Governance',
  other: 'Other Documents',
};

const ACCESS_LEVEL_LABELS = {
  public: 'Public',
  backer: 'Backers Only',
  viewer: 'Team Viewers',
  editor: 'Editors Only',
  manager: 'Managers Only',
  owner: 'Owners Only',
};

const ACCESS_LEVEL_COLORS = {
  public: { bg: '#e0f2fe', text: '#0369a1', border: '#bae6fd' },
  backer: { bg: '#ecfdf5', text: '#047857', border: '#a7f3d0' },
  viewer: { bg: '#fef3c7', text: '#b45309', border: '#fde68a' },
  editor: { bg: '#ede9fe', text: '#6d28d9', border: '#ddd6fe' },
  manager: { bg: '#fae8ff', text: '#a21caf', border: '#f5d0fe' },
  owner: { bg: '#ffe4e6', text: '#be123c', border: '#fecdd3' },
};

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i] || 'B'}`;
}

export default function CampaignDataRoom({ campaignId, user }) {
  const [activeTab, setActiveTab] = useState('files'); // 'files' | 'logs'
  const [files, setFiles] = useState([]);
  const [total, setTotal] = useState(0);
  const [categoriesSummary, setCategoriesSummary] = useState({});
  const [userRole, setUserRole] = useState('public');
  const [canUpload, setCanUpload] = useState(false);
  const [canViewLogs, setCanViewLogs] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Upload modal state
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadCategory, setUploadCategory] = useState('pitch_deck');
  const [uploadAccessLevel, setUploadAccessLevel] = useState('backer');
  const [uploadDescription, setUploadDescription] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadExternalUrl, setUploadExternalUrl] = useState('');
  const [uploadMode, setUploadMode] = useState('file'); // 'file' | 'url'
  const [uploadSubmitting, setUploadSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState('');

  // Edit modal state
  const [editingFile, setEditingFile] = useState(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState('other');
  const [editAccessLevel, setEditAccessLevel] = useState('backer');
  const [editDescription, setEditDescription] = useState('');
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState('');

  // Access logs state
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');

  const loadFiles = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (selectedCategory && selectedCategory !== 'all') {
        params.category = selectedCategory;
      }
      if (searchQuery.trim()) {
        params.search = searchQuery.trim();
      }
      const data = await api.getCampaignDataRoomFiles(campaignId, params);
      setFiles(data.files || []);
      setTotal(data.total || 0);
      setUserRole(data.user_role || 'public');
      setCanUpload(Boolean(data.can_upload));
      setCanViewLogs(Boolean(data.can_view_logs));
      setCategoriesSummary(data.categories_summary || {});
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Could not load data room documents');
    } finally {
      setLoading(false);
    }
  }, [campaignId, selectedCategory, searchQuery]);

  const loadLogs = useCallback(async () => {
    if (!campaignId) return;
    setLogsLoading(true);
    setLogsError('');
    try {
      const data = await api.getCampaignDataRoomLogs(campaignId, { limit: 50 });
      setLogs(data.logs || []);
    } catch (err) {
      setLogsError(err?.response?.data?.error || err.message || 'Could not load audit access logs');
    } finally {
      setLogsLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    if (activeTab === 'logs' && canViewLogs) {
      loadLogs();
    }
  }, [activeTab, canViewLogs, loadLogs]);

  const handleDownload = async (file) => {
    try {
      const res = await api.getCampaignDataRoomDownload(campaignId, file.id);
      const downloadUrl = res?.download_url || file.file_url;
      if (downloadUrl) {
        window.open(downloadUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      alert(err?.response?.data?.error || err.message || 'Download failed');
    }
  };

  const handleDelete = async (fileId) => {
    if (!window.confirm('Are you sure you want to delete this document from the data room?')) {
      return;
    }
    try {
      await api.deleteCampaignDataRoomFile(campaignId, fileId);
      await loadFiles();
    } catch (err) {
      alert(err?.response?.data?.error || err.message || 'Could not delete document');
    }
  };

  const handleUploadSubmit = async (e) => {
    e.preventDefault();
    setUploadError('');
    if (!uploadName.trim()) {
      setUploadError('Document name is required');
      return;
    }
    if (uploadMode === 'file' && !uploadFile) {
      setUploadError('Please select a file to upload');
      return;
    }
    if (uploadMode === 'url' && !uploadExternalUrl.trim()) {
      setUploadError('Please enter a valid document URL');
      return;
    }

    setUploadSubmitting(true);
    try {
      if (uploadMode === 'file') {
        const formData = new FormData();
        formData.append('file', uploadFile);
        formData.append('name', uploadName.trim());
        formData.append('category', uploadCategory);
        formData.append('access_level', uploadAccessLevel);
        if (uploadDescription.trim()) {
          formData.append('description', uploadDescription.trim());
        }
        await api.uploadCampaignDataRoomFile(campaignId, formData);
      } else {
        await api.uploadCampaignDataRoomFile(campaignId, {
          name: uploadName.trim(),
          file_url: uploadExternalUrl.trim(),
          category: uploadCategory,
          access_level: uploadAccessLevel,
          description: uploadDescription.trim() || undefined,
        });
      }
      setShowUploadModal(false);
      setUploadName('');
      setUploadDescription('');
      setUploadFile(null);
      setUploadExternalUrl('');
      await loadFiles();
    } catch (err) {
      setUploadError(err?.response?.data?.error || err.message || 'Failed to upload document');
    } finally {
      setUploadSubmitting(false);
    }
  };

  const handleEditOpen = (file) => {
    setEditingFile(file);
    setEditName(file.name);
    setEditCategory(file.category);
    setEditAccessLevel(file.access_level);
    setEditDescription(file.description || '');
    setEditError('');
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    setEditError('');
    if (!editName.trim()) {
      setEditError('Document name is required');
      return;
    }

    setEditSubmitting(true);
    try {
      await api.updateCampaignDataRoomFile(campaignId, editingFile.id, {
        name: editName.trim(),
        category: editCategory,
        access_level: editAccessLevel,
        description: editDescription.trim() || null,
      });
      setEditingFile(null);
      await loadFiles();
    } catch (err) {
      setEditError(err?.response?.data?.error || err.message || 'Failed to update document');
    } finally {
      setEditSubmitting(false);
    }
  };

  return (
    <section
      role="region"
      aria-label="Campaign Data Room"
      style={{
        marginTop: '2rem',
        marginBottom: '2.5rem',
        padding: '1.5rem',
        background: 'var(--color-bg-card, #ffffff)',
        borderRadius: '12px',
        border: '1px solid var(--color-border-light, #e2e8f0)',
        boxShadow: '0 2px 4px rgba(0,0,0,0.03)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          marginBottom: '1rem',
          borderBottom: '1px solid var(--color-border-light, #e2e8f0)',
          paddingBottom: '1rem',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <h2
              style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                color: 'var(--color-text-primary, #0f172a)',
                margin: 0,
              }}
            >
              Campaign Data Room
            </h2>
            <span
              role="status"
              aria-label={`Your access role: ${userRole}`}
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                textTransform: 'uppercase',
                padding: '0.2rem 0.55rem',
                borderRadius: '6px',
                background: ACCESS_LEVEL_COLORS[userRole]?.bg || '#f1f5f9',
                color: ACCESS_LEVEL_COLORS[userRole]?.text || '#475569',
                border: `1px solid ${ACCESS_LEVEL_COLORS[userRole]?.border || '#cbd5e1'}`,
              }}
            >
              Role: {userRole}
            </span>
          </div>
          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--color-text-secondary, #64748b)',
              margin: '0.35rem 0 0',
            }}
          >
            Confidential due diligence attachments, financial disclosures, and governance reports
            with role-based access control.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {canViewLogs && (
            <div role="tablist" style={{ display: 'flex', gap: '0.3rem' }}>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'files'}
                onClick={() => setActiveTab('files')}
                style={{
                  padding: '0.4rem 0.8rem',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light, #e2e8f0)',
                  background:
                    activeTab === 'files' ? 'var(--color-accent, #2563eb)' : 'transparent',
                  color: activeTab === 'files' ? '#ffffff' : 'var(--color-text-primary, #0f172a)',
                  cursor: 'pointer',
                }}
              >
                Files ({total})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'logs'}
                onClick={() => setActiveTab('logs')}
                style={{
                  padding: '0.4rem 0.8rem',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light, #e2e8f0)',
                  background: activeTab === 'logs' ? 'var(--color-accent, #2563eb)' : 'transparent',
                  color: activeTab === 'logs' ? '#ffffff' : 'var(--color-text-primary, #0f172a)',
                  cursor: 'pointer',
                }}
              >
                Access Logs
              </button>
            </div>
          )}

          {canUpload && (
            <button
              type="button"
              onClick={() => setShowUploadModal(true)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.45rem 0.9rem',
                fontSize: '0.82rem',
                fontWeight: 600,
                borderRadius: '6px',
                background: 'var(--color-accent, #2563eb)',
                color: '#ffffff',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              + Upload Document
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            background: '#fef2f2',
            color: '#b91c1c',
            borderRadius: '6px',
            fontSize: '0.85rem',
          }}
        >
          {error}
        </div>
      )}

      {activeTab === 'files' && (
        <>
          {/* Category & Search Controls */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.75rem',
              marginBottom: '1.25rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.35rem',
              }}
              role="group"
              aria-label="Filter documents by category"
            >
              {Object.keys(CATEGORY_LABELS).map((catKey) => {
                const isSelected = selectedCategory === catKey;
                const count = catKey === 'all' ? total : categoriesSummary[catKey] || 0;
                return (
                  <button
                    key={catKey}
                    type="button"
                    onClick={() => setSelectedCategory(catKey)}
                    style={{
                      padding: '0.3rem 0.65rem',
                      fontSize: '0.78rem',
                      fontWeight: isSelected ? 600 : 500,
                      borderRadius: '16px',
                      border: isSelected
                        ? '1px solid var(--color-accent, #2563eb)'
                        : '1px solid var(--color-border-light, #e2e8f0)',
                      background: isSelected ? 'var(--color-accent, #2563eb)' : '#f8fafc',
                      color: isSelected ? '#ffffff' : 'var(--color-text-secondary, #475569)',
                      cursor: 'pointer',
                    }}
                  >
                    {CATEGORY_LABELS[catKey]} ({count})
                  </button>
                );
              })}
            </div>

            <div style={{ minWidth: '220px', flex: '0 1 280px' }}>
              <input
                type="search"
                placeholder="Search documents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search data room documents"
                style={{
                  width: '100%',
                  padding: '0.4rem 0.75rem',
                  fontSize: '0.82rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light, #cbd5e1)',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          {/* Documents Table / List */}
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
              Loading documents...
            </div>
          ) : files.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '2.5rem 1rem',
                background: '#f8fafc',
                borderRadius: '8px',
                border: '1px dashed #cbd5e1',
                color: '#64748b',
              }}
            >
              <p style={{ margin: 0, fontWeight: 600, fontSize: '0.95rem' }}>
                No documents found in the Data Room
              </p>
              <p style={{ margin: '0.35rem 0 0', fontSize: '0.82rem' }}>
                {userRole === 'public'
                  ? 'Sign in or back this campaign to access restricted documents.'
                  : 'No files match your current category or search filter.'}
              </p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '0.85rem',
                  textAlign: 'left',
                }}
              >
                <thead>
                  <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#64748b' }}>
                    <th style={{ padding: '0.6rem 0.75rem', fontWeight: 600 }}>Document</th>
                    <th style={{ padding: '0.6rem 0.75rem', fontWeight: 600 }}>Category</th>
                    <th style={{ padding: '0.6rem 0.75rem', fontWeight: 600 }}>Access Level</th>
                    <th style={{ padding: '0.6rem 0.75rem', fontWeight: 600 }}>Size</th>
                    <th style={{ padding: '0.6rem 0.75rem', fontWeight: 600 }}>Uploaded</th>
                    <th style={{ padding: '0.6rem 0.75rem', fontWeight: 600, textAlign: 'right' }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => {
                    const badge =
                      ACCESS_LEVEL_COLORS[file.access_level] || ACCESS_LEVEL_COLORS.public;
                    return (
                      <tr
                        key={file.id}
                        style={{
                          borderBottom: '1px solid #f1f5f9',
                          transition: 'background 0.15s ease',
                        }}
                      >
                        <td style={{ padding: '0.75rem' }}>
                          <div style={{ fontWeight: 600, color: '#0f172a' }}>{file.name}</div>
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: '#64748b',
                              marginTop: '0.1rem',
                            }}
                          >
                            {file.original_filename}
                            {file.description && ` · ${file.description}`}
                          </div>
                        </td>
                        <td style={{ padding: '0.75rem' }}>
                          <span
                            style={{
                              fontSize: '0.75rem',
                              padding: '0.15rem 0.5rem',
                              borderRadius: '4px',
                              background: '#f1f5f9',
                              color: '#334155',
                            }}
                          >
                            {CATEGORY_LABELS[file.category] || file.category}
                          </span>
                        </td>
                        <td style={{ padding: '0.75rem' }}>
                          <span
                            role="status"
                            aria-label={`Access requirement: ${ACCESS_LEVEL_LABELS[file.access_level]}`}
                            style={{
                              fontSize: '0.72rem',
                              fontWeight: 600,
                              padding: '0.2rem 0.5rem',
                              borderRadius: '6px',
                              background: badge.bg,
                              color: badge.text,
                              border: `1px solid ${badge.border}`,
                            }}
                          >
                            {ACCESS_LEVEL_LABELS[file.access_level] || file.access_level}
                          </span>
                        </td>
                        <td style={{ padding: '0.75rem', color: '#64748b' }}>
                          {formatBytes(file.file_size)}
                        </td>
                        <td style={{ padding: '0.75rem', color: '#64748b', fontSize: '0.78rem' }}>
                          {file.created_at ? new Date(file.created_at).toLocaleDateString() : '—'}
                          {file.uploader_name && (
                            <div style={{ fontSize: '0.72rem' }}>by {file.uploader_name}</div>
                          )}
                        </td>
                        <td
                          style={{ padding: '0.75rem', textAlign: 'right', whiteSpace: 'nowrap' }}
                        >
                          <button
                            type="button"
                            onClick={() => handleDownload(file)}
                            style={{
                              padding: '0.35rem 0.75rem',
                              fontSize: '0.78rem',
                              fontWeight: 600,
                              borderRadius: '4px',
                              background: '#0284c7',
                              color: '#ffffff',
                              border: 'none',
                              cursor: 'pointer',
                              marginRight: file.can_manage ? '0.4rem' : '0',
                            }}
                          >
                            Download
                          </button>
                          {file.can_manage && (
                            <>
                              <button
                                type="button"
                                onClick={() => handleEditOpen(file)}
                                aria-label={`Edit ${file.name}`}
                                style={{
                                  padding: '0.35rem 0.55rem',
                                  fontSize: '0.78rem',
                                  borderRadius: '4px',
                                  background: 'transparent',
                                  color: '#475569',
                                  border: '1px solid #cbd5e1',
                                  cursor: 'pointer',
                                  marginRight: '0.3rem',
                                }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(file.id)}
                                aria-label={`Delete ${file.name}`}
                                style={{
                                  padding: '0.35rem 0.55rem',
                                  fontSize: '0.78rem',
                                  borderRadius: '4px',
                                  background: 'transparent',
                                  color: '#dc2626',
                                  border: '1px solid #fecaca',
                                  cursor: 'pointer',
                                }}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {activeTab === 'logs' && canViewLogs && (
        <div>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
            Data Room Audit Trail & Access Logs
          </h3>
          {logsLoading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
              Loading audit logs...
            </div>
          ) : logsError ? (
            <div style={{ color: '#dc2626', fontSize: '0.85rem' }}>{logsError}</div>
          ) : logs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
              No audit logs recorded yet.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '0.82rem',
                  textAlign: 'left',
                }}
              >
                <thead>
                  <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#64748b' }}>
                    <th style={{ padding: '0.5rem' }}>Timestamp</th>
                    <th style={{ padding: '0.5rem' }}>Action</th>
                    <th style={{ padding: '0.5rem' }}>Document</th>
                    <th style={{ padding: '0.5rem' }}>User</th>
                    <th style={{ padding: '0.5rem' }}>IP Address</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '0.5rem', whiteSpace: 'nowrap' }}>
                        {new Date(log.created_at).toLocaleString()}
                      </td>
                      <td style={{ padding: '0.5rem' }}>
                        <span
                          style={{
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            fontSize: '0.72rem',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            background:
                              log.action === 'download'
                                ? '#e0f2fe'
                                : log.action === 'upload'
                                  ? '#ecfdf5'
                                  : '#f1f5f9',
                            color:
                              log.action === 'download'
                                ? '#0369a1'
                                : log.action === 'upload'
                                  ? '#047857'
                                  : '#334155',
                          }}
                        >
                          {log.action}
                        </span>
                      </td>
                      <td style={{ padding: '0.5rem', fontWeight: 500 }}>
                        {log.file_name || log.file_id}
                      </td>
                      <td style={{ padding: '0.5rem', color: '#475569' }}>
                        {log.user_name ||
                          log.user_email ||
                          (log.user_id ? 'Authenticated User' : 'Guest')}
                      </td>
                      <td style={{ padding: '0.5rem', color: '#64748b', fontSize: '0.75rem' }}>
                        {log.ip_address || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="upload-modal-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: '12px',
              maxWidth: '500px',
              width: '100%',
              padding: '1.5rem',
              boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
            }}
          >
            <h3 id="upload-modal-title" style={{ margin: '0 0 1rem', fontSize: '1.15rem' }}>
              Upload Data Room Document
            </h3>

            {uploadError && (
              <div
                role="alert"
                style={{
                  padding: '0.6rem 0.8rem',
                  marginBottom: '1rem',
                  background: '#fef2f2',
                  color: '#b91c1c',
                  borderRadius: '6px',
                  fontSize: '0.82rem',
                }}
              >
                {uploadError}
              </div>
            )}

            <form onSubmit={handleUploadSubmit}>
              <div style={{ marginBottom: '0.85rem' }}>
                <label
                  style={{
                    display: 'block',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    marginBottom: '0.3rem',
                  }}
                >
                  Upload Mode
                </label>
                <div style={{ display: 'flex', gap: '1rem', fontSize: '0.82rem' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                    <input
                      type="radio"
                      name="uploadMode"
                      value="file"
                      checked={uploadMode === 'file'}
                      onChange={() => setUploadMode('file')}
                    />
                    Direct File Upload (up to 25MB)
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                    <input
                      type="radio"
                      name="uploadMode"
                      value="url"
                      checked={uploadMode === 'url'}
                      onChange={() => setUploadMode('url')}
                    />
                    External Document Link
                  </label>
                </div>
              </div>

              {uploadMode === 'file' ? (
                <div key="mode-file" style={{ marginBottom: '0.85rem' }}>
                  <label
                    htmlFor="file-input"
                    style={{
                      display: 'block',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      marginBottom: '0.3rem',
                    }}
                  >
                    Choose File *
                  </label>
                  <input
                    key="file-input"
                    id="file-input"
                    type="file"
                    onChange={(e) => {
                      const f = e.target.files[0];
                      setUploadFile(f);
                      if (f && !uploadName) {
                        setUploadName(f.name.replace(/\.[^/.]+$/, ''));
                      }
                    }}
                    style={{ width: '100%', fontSize: '0.82rem' }}
                  />
                  <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.2rem' }}>
                    PDF, DOCX, XLSX, PPTX, images, text, and zip files allowed.
                  </div>
                </div>
              ) : (
                <div key="mode-url" style={{ marginBottom: '0.85rem' }}>
                  <label
                    htmlFor="url-input"
                    style={{
                      display: 'block',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      marginBottom: '0.3rem',
                    }}
                  >
                    Document URL *
                  </label>
                  <input
                    key="url-input"
                    id="url-input"
                    type="url"
                    placeholder="https://..."
                    value={uploadExternalUrl || ''}
                    onChange={(e) => setUploadExternalUrl(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.45rem',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.82rem',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              )}

              <div style={{ marginBottom: '0.85rem' }}>
                <label
                  htmlFor="name-input"
                  style={{
                    display: 'block',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    marginBottom: '0.3rem',
                  }}
                >
                  Document Title *
                </label>
                <input
                  id="name-input"
                  type="text"
                  placeholder="e.g. Q3 2026 Audited Financials"
                  value={uploadName || ''}
                  onChange={(e) => setUploadName(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.45rem',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.82rem',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.85rem' }}>
                <div style={{ flex: 1 }}>
                  <label
                    htmlFor="category-select"
                    style={{
                      display: 'block',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      marginBottom: '0.3rem',
                    }}
                  >
                    Category
                  </label>
                  <select
                    id="category-select"
                    value={uploadCategory}
                    onChange={(e) => setUploadCategory(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.45rem',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.82rem',
                    }}
                  >
                    <option value="pitch_deck">Pitch Deck</option>
                    <option value="financials">Financials</option>
                    <option value="legal">Legal & Contracts</option>
                    <option value="technical">Technical</option>
                    <option value="diligence">Due Diligence</option>
                    <option value="governance">Governance</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div style={{ flex: 1 }}>
                  <label
                    htmlFor="access-select"
                    style={{
                      display: 'block',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      marginBottom: '0.3rem',
                    }}
                  >
                    Access Level
                  </label>
                  <select
                    id="access-select"
                    value={uploadAccessLevel}
                    onChange={(e) => setUploadAccessLevel(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.45rem',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.82rem',
                    }}
                  >
                    <option value="public">Public (Anyone)</option>
                    <option value="backer">Backers Only</option>
                    <option value="viewer">Team Viewers</option>
                    <option value="editor">Editors Only</option>
                    {['manager', 'owner', 'admin'].includes(userRole) && (
                      <option value="manager">Managers Only</option>
                    )}
                    {['owner', 'admin'].includes(userRole) && (
                      <option value="owner">Owners Only</option>
                    )}
                  </select>
                </div>
              </div>

              <div style={{ marginBottom: '1.25rem' }}>
                <label
                  htmlFor="desc-input"
                  style={{
                    display: 'block',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    marginBottom: '0.3rem',
                  }}
                >
                  Description (Optional)
                </label>
                <textarea
                  id="desc-input"
                  rows={2}
                  placeholder="Notes or context for reviewers..."
                  value={uploadDescription}
                  onChange={(e) => setUploadDescription(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.45rem',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.82rem',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setShowUploadModal(false)}
                  style={{
                    padding: '0.45rem 0.9rem',
                    fontSize: '0.82rem',
                    borderRadius: '6px',
                    background: 'transparent',
                    border: '1px solid #cbd5e1',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uploadSubmitting}
                  style={{
                    padding: '0.45rem 1rem',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    borderRadius: '6px',
                    background: 'var(--color-accent, #2563eb)',
                    color: '#ffffff',
                    border: 'none',
                    cursor: uploadSubmitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {uploadSubmitting ? 'Uploading...' : 'Confirm Upload'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingFile && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-modal-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              borderRadius: '12px',
              maxWidth: '480px',
              width: '100%',
              padding: '1.5rem',
              boxShadow: '0 10px 25px rgba(0,0,0,0.15)',
            }}
          >
            <h3 id="edit-modal-title" style={{ margin: '0 0 1rem', fontSize: '1.15rem' }}>
              Edit Document Metadata
            </h3>

            {editError && (
              <div
                role="alert"
                style={{
                  padding: '0.6rem 0.8rem',
                  marginBottom: '1rem',
                  background: '#fef2f2',
                  color: '#b91c1c',
                  borderRadius: '6px',
                  fontSize: '0.82rem',
                }}
              >
                {editError}
              </div>
            )}

            <form onSubmit={handleEditSubmit}>
              <div style={{ marginBottom: '0.85rem' }}>
                <label
                  htmlFor="edit-name"
                  style={{
                    display: 'block',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    marginBottom: '0.3rem',
                  }}
                >
                  Document Title *
                </label>
                <input
                  id="edit-name"
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.45rem',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.82rem',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.85rem' }}>
                <div style={{ flex: 1 }}>
                  <label
                    htmlFor="edit-category"
                    style={{
                      display: 'block',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      marginBottom: '0.3rem',
                    }}
                  >
                    Category
                  </label>
                  <select
                    id="edit-category"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.45rem',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.82rem',
                    }}
                  >
                    <option value="pitch_deck">Pitch Deck</option>
                    <option value="financials">Financials</option>
                    <option value="legal">Legal & Contracts</option>
                    <option value="technical">Technical</option>
                    <option value="diligence">Due Diligence</option>
                    <option value="governance">Governance</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div style={{ flex: 1 }}>
                  <label
                    htmlFor="edit-access"
                    style={{
                      display: 'block',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      marginBottom: '0.3rem',
                    }}
                  >
                    Access Level
                  </label>
                  <select
                    id="edit-access"
                    value={editAccessLevel}
                    onChange={(e) => setEditAccessLevel(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.45rem',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.82rem',
                    }}
                  >
                    <option value="public">Public</option>
                    <option value="backer">Backers Only</option>
                    <option value="viewer">Team Viewers</option>
                    <option value="editor">Editors Only</option>
                    {['manager', 'owner', 'admin'].includes(userRole) && (
                      <option value="manager">Managers Only</option>
                    )}
                    {['owner', 'admin'].includes(userRole) && (
                      <option value="owner">Owners Only</option>
                    )}
                  </select>
                </div>
              </div>

              <div style={{ marginBottom: '1.25rem' }}>
                <label
                  htmlFor="edit-desc"
                  style={{
                    display: 'block',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    marginBottom: '0.3rem',
                  }}
                >
                  Description (Optional)
                </label>
                <textarea
                  id="edit-desc"
                  rows={2}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.45rem',
                    borderRadius: '6px',
                    border: '1px solid #cbd5e1',
                    fontSize: '0.82rem',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setEditingFile(null)}
                  style={{
                    padding: '0.45rem 0.9rem',
                    fontSize: '0.82rem',
                    borderRadius: '6px',
                    background: 'transparent',
                    border: '1px solid #cbd5e1',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editSubmitting}
                  style={{
                    padding: '0.45rem 1rem',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    borderRadius: '6px',
                    background: 'var(--color-accent, #2563eb)',
                    color: '#ffffff',
                    border: 'none',
                    cursor: editSubmitting ? 'not-allowed' : 'pointer',
                  }}
                >
                  {editSubmitting ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
