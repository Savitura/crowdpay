import React from 'react';
import WithdrawalsSection from '../../WithdrawalsSection';
import TransactionHistory from '../../TransactionHistory';
import WithdrawalHistoryTimeline from '../../WithdrawalHistoryTimeline';
import MilestoneTracker from '../../MilestoneTracker';
import MilestoneVotePanel from '../../MilestoneVotePanel';
import SponsorMatchingPanel from '../../SponsorMatchingPanel';
import BudgetBreakdown from '../../BudgetBreakdown';
import OutcomeSurveyPanel from '../OutcomeSurveyPanel';
import OutcomeSurveyEditor from '../OutcomeSurveyEditor';
import CampaignCommunicationPreferences from '../../CampaignCommunicationPreferences';
import { api } from '../../../services/api';

export default function CampaignAboutTab({
  campaign,
  milestones = [],
  setMilestones,
  stretchGoals = [],
  user = null,
  token = null,
  canEditCampaign = false,
  canManageTeam = false,
  setCampaign,
}) {
  if (!campaign) return null;

  return (
    <div style={{ marginBottom: '2rem' }}>
      {token && (
        <div id="withdrawals" data-no-print style={{ marginBottom: '1.5rem' }}>
          <WithdrawalsSection
            campaign={campaign}
            milestones={milestones}
            user={user}
            token={token}
            onReleased={() => {
              api
                .getCampaign(campaign.id)
                .then(setCampaign)
                .catch(() => {});
              api
                .getMilestones(campaign.id)
                .then(setMilestones)
                .catch(() => {});
            }}
          />
        </div>
      )}

      <TransactionHistory
        campaignId={campaign.id}
        isCreator={Boolean(user?.id && campaign.creator_id === user.id)}
      />

      <WithdrawalHistoryTimeline campaignId={campaign.id} token={token} />

      <MilestoneTracker milestones={milestones} assetType={campaign.asset_type} />
      <MilestoneVotePanel milestones={milestones} />

      <SponsorMatchingPanel campaignId={campaign.id} campaignStatus={campaign.status} user={user} />

      <BudgetBreakdown
        campaignId={campaign.id}
        targetAmount={campaign.target_amount}
        disabled={!canEditCampaign}
      />

      {/* Stretch Goals (#585) */}
      {stretchGoals.length > 0 && (
        <div className="campaign-card" style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 700 }}>
            Stretch Goals
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {stretchGoals.map((goal) => {
              const reached = Number(campaign.raised_amount) >= Number(goal.amount);
              return (
                <div
                  key={goal.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    padding: '0.65rem 0.9rem',
                    borderRadius: 8,
                    border: `1px solid ${reached ? 'var(--color-success, #22c55e)' : 'var(--color-border)'}`,
                    background: reached ? 'var(--color-success-bg, #f0fdf4)' : 'transparent',
                  }}
                >
                  <span
                    style={{
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      color: reached ? 'var(--color-success, #22c55e)' : 'var(--color-text-hint)',
                      flexShrink: 0,
                    }}
                  >
                    {reached ? '[Achieved]' : '[Target]'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '0.5rem',
                        flexWrap: 'wrap',
                      }}
                    >
                      <strong style={{ fontSize: '0.9rem' }}>{goal.title}</strong>
                      <span
                        style={{
                          fontSize: '0.8rem',
                          color: 'var(--color-text-hint)',
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {Number(goal.amount).toLocaleString()} {campaign.asset_type}
                      </span>
                    </div>
                    {goal.description && (
                      <p
                        style={{
                          margin: '0.2rem 0 0',
                          fontSize: '0.82rem',
                          color: 'var(--color-text-secondary)',
                        }}
                      >
                        {goal.description}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Beneficiary outcome survey (#960) and per-campaign communication preferences (#961) */}
      <div style={{ marginBottom: '2rem' }} data-no-print>
        {canManageTeam ? (
          <OutcomeSurveyEditor campaignId={campaign.id} />
        ) : (
          <OutcomeSurveyPanel campaignId={campaign.id} canRespond={Boolean(user)} />
        )}
      </div>

      {user && !canManageTeam && (
        <div style={{ marginBottom: '2rem' }} data-no-print>
          <CampaignCommunicationPreferences campaignId={campaign.id} />
        </div>
      )}
    </div>
  );
}
