import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../renderWithProviders';
import OutcomeSurveyPanel from '../../components/campaign/OutcomeSurveyPanel';

vi.mock('../../services/api', () => ({
  api: {
    getOutcomeSurvey: vi.fn(),
    submitOutcomeSurveyResponse: vi.fn(),
  },
}));

import { api } from '../../services/api';

const SURVEY = {
  id: 'survey-1',
  campaign_id: 'campaign-1',
  title: 'How did the well project go?',
  intro: 'Two minutes, tops.',
  status: 'open',
  questions: [
    { id: 'delivery', prompt: 'Did the work arrive as promised?', type: 'rating', required: true },
    {
      id: 'reuse',
      prompt: 'Would you back this again?',
      type: 'single_choice',
      required: true,
      options: ['Yes', 'No'],
    },
    { id: 'notes', prompt: 'Anything else?', type: 'text', required: false },
  ],
};

const payload = (overrides = {}) => ({
  survey: SURVEY,
  response_count: 7,
  my_response: null,
  ...overrides,
});

describe('OutcomeSurveyPanel (#960)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading state while the survey is fetched', () => {
    api.getOutcomeSurvey.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading the survey…');
  });

  it('explains the empty state when the campaign has no survey', async () => {
    api.getOutcomeSurvey.mockResolvedValue({
      survey: null,
      response_count: 0,
      my_response: null,
    });
    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);

    expect(
      await screen.findByText('This campaign has not published an outcome survey yet.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit my response' })).not.toBeInTheDocument();
  });

  it('hides an unpublished draft behind the same quiet empty state', async () => {
    api.getOutcomeSurvey.mockResolvedValue(
      payload({ survey: { ...SURVEY, status: 'draft', questions: [] } })
    );
    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);

    expect(
      await screen.findByText('This campaign has not published an outcome survey yet.')
    ).toBeInTheDocument();
  });

  it('surfaces a load failure', async () => {
    api.getOutcomeSurvey.mockRejectedValue(new Error('Network error'));
    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
  });

  it('renders one control per question type', async () => {
    api.getOutcomeSurvey.mockResolvedValue(payload());
    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);

    await screen.findByText(SURVEY.title);
    expect(
      screen.getByRole('radiogroup', { name: 'Did the work arrive as promised?' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Would you back this again?').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Anything else?').tagName).toBe('TEXTAREA');
    expect(screen.getByText('7 response(s) so far')).toBeInTheDocument();
  });

  it('submits every answer and confirms', async () => {
    api.getOutcomeSurvey.mockResolvedValue(payload());
    api.submitOutcomeSurveyResponse.mockResolvedValue({ id: 'resp-1' });

    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);
    await screen.findByText(SURVEY.title);

    await userEvent.click(screen.getByRole('radio', { name: '5' }));
    await userEvent.selectOptions(screen.getByLabelText('Would you back this again?'), 'Yes');
    await userEvent.type(screen.getByLabelText('Anything else?'), 'shipped early');
    await userEvent.click(screen.getByRole('button', { name: 'Submit my response' }));

    await waitFor(() =>
      expect(api.submitOutcomeSurveyResponse).toHaveBeenCalledWith('campaign-1', {
        delivery: 5,
        reuse: 'Yes',
        notes: 'shipped early',
      })
    );
    expect(
      await screen.findByText('Thanks — your response has been recorded.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit my response' })).not.toBeInTheDocument();
  });

  it('omits an unanswered optional question from the payload', async () => {
    api.getOutcomeSurvey.mockResolvedValue(payload());
    api.submitOutcomeSurveyResponse.mockResolvedValue({ id: 'resp-1' });

    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);
    await screen.findByText(SURVEY.title);

    await userEvent.click(screen.getByRole('radio', { name: '3' }));
    await userEvent.selectOptions(screen.getByLabelText('Would you back this again?'), 'No');
    await userEvent.click(screen.getByRole('button', { name: 'Submit my response' }));

    await waitFor(() =>
      expect(api.submitOutcomeSurveyResponse).toHaveBeenCalledWith('campaign-1', {
        delivery: 3,
        reuse: 'No',
      })
    );
  });

  it('keeps the answers and shows the server error when submission fails', async () => {
    api.getOutcomeSurvey.mockResolvedValue(payload());
    api.submitOutcomeSurveyResponse.mockRejectedValue(
      new Error('You have already responded to this outcome survey')
    );

    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);
    await screen.findByText(SURVEY.title);

    await userEvent.click(screen.getByRole('radio', { name: '4' }));
    await userEvent.selectOptions(screen.getByLabelText('Would you back this again?'), 'Yes');
    await userEvent.click(screen.getByRole('button', { name: 'Submit my response' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already responded');
    expect(screen.getByRole('radio', { name: '4' })).toBeChecked();
    expect(screen.getByLabelText('Would you back this again?')).toHaveValue('Yes');
  });

  it('prefills and locks the form when the caller already responded', async () => {
    api.getOutcomeSurvey.mockResolvedValue(
      payload({
        my_response: { id: 'resp-1', answers: { delivery: 5, reuse: 'Yes' } },
      })
    );

    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);

    expect(
      await screen.findByText('Thanks — your response has been recorded.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit my response' })).not.toBeInTheDocument();
  });

  it('renders a closed survey as read-only', async () => {
    api.getOutcomeSurvey.mockResolvedValue(payload({ survey: { ...SURVEY, status: 'closed' } }));

    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);

    expect(await screen.findByText('Closed')).toBeInTheDocument();
    expect(
      screen.getByText('This survey is closed and is no longer accepting responses.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit my response' })).not.toBeInTheDocument();
  });

  it('tells an anonymous visitor that only backers can respond', async () => {
    api.getOutcomeSurvey.mockResolvedValue(payload());
    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" canRespond={false} />);

    expect(
      await screen.findByText('Only people who contributed to this campaign can respond.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit my response' })).not.toBeInTheDocument();
  });

  it('caps free-text answers at the documented length', async () => {
    api.getOutcomeSurvey.mockResolvedValue(payload());
    renderWithProviders(<OutcomeSurveyPanel campaignId="campaign-1" />);

    const textarea = await screen.findByLabelText('Anything else?');
    expect(textarea).toHaveAttribute('maxlength', '2000');
  });
});
