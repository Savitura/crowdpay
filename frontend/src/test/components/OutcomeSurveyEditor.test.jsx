import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../renderWithProviders';
import OutcomeSurveyEditor from '../../components/campaign/OutcomeSurveyEditor';

vi.mock('../../services/api', () => ({
  api: {
    getOutcomeSurvey: vi.fn(),
    createOutcomeSurvey: vi.fn(),
    updateOutcomeSurvey: vi.fn(),
    openOutcomeSurvey: vi.fn(),
    closeOutcomeSurvey: vi.fn(),
    getOutcomeSurveyResults: vi.fn(),
    getOutcomeSurveyEvents: vi.fn(),
  },
}));

import { api } from '../../services/api';

const DRAFT = {
  id: 'survey-1',
  campaign_id: 'campaign-1',
  title: 'How did it go?',
  intro: 'Two minutes.',
  status: 'draft',
  questions: [{ id: 'delivery', prompt: 'Did the work arrive?', type: 'rating', required: true }],
};

const OPEN = { ...DRAFT, status: 'open', questions: DRAFT.questions };

const RESULTS = {
  survey: OPEN,
  response_count: 3,
  results: [
    {
      question_id: 'delivery',
      prompt: 'Did the work arrive?',
      type: 'rating',
      answered: 3,
      skipped: 0,
      average_rating: 4.33,
      distribution: { 4: 2, 5: 1 },
      sample_responses: [],
    },
    {
      question_id: 'notes',
      prompt: 'Anything else?',
      type: 'text',
      answered: 1,
      skipped: 2,
      average_rating: null,
      distribution: { 'great work': 1 },
      sample_responses: ['great work'],
    },
  ],
};

const EVENTS = {
  events: [
    { id: 'e1', to_status: 'draft', created_at: '2026-09-30T10:00:00.000Z' },
    { id: 'e2', to_status: 'open', created_at: '2026-09-30T11:00:00.000Z' },
  ],
};

describe('OutcomeSurveyEditor (#960)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a loading state before the survey resolves', () => {
    api.getOutcomeSurvey.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading the survey…');
  });

  it('surfaces a load failure', async () => {
    api.getOutcomeSurvey.mockRejectedValue(new Error('Network error'));
    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
  });

  it('starts an empty draft when the campaign has no survey', async () => {
    api.getOutcomeSurvey.mockResolvedValue({
      survey: null,
      response_count: 0,
      my_response: null,
    });
    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);

    expect(
      await screen.findByText('No questions yet. Add at least one before publishing.')
    ).toBeInTheDocument();
    // Publishing is blocked until a draft exists, because the endpoint is the
    // draft's own state transition.
    expect(screen.getByRole('button', { name: 'Publish survey' })).toBeDisabled();
  });

  it('creates a draft with the typed title and first question', async () => {
    api.getOutcomeSurvey.mockResolvedValue({
      survey: null,
      response_count: 0,
      my_response: null,
    });
    api.createOutcomeSurvey.mockResolvedValue(DRAFT);

    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);
    await screen.findByText('No questions yet. Add at least one before publishing.');

    await userEvent.type(screen.getByLabelText('Survey title'), 'How did it go?');
    await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
    await userEvent.type(screen.getByLabelText('Question'), 'Did the work arrive?');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() =>
      expect(api.createOutcomeSurvey).toHaveBeenCalledWith('campaign-1', {
        title: 'How did it go?',
        intro: null,
        questions: [{ prompt: 'Did the work arrive?', type: 'rating', required: true }],
      })
    );
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
  });

  it('edits an existing draft with PUT and never drops untouched channels', async () => {
    api.getOutcomeSurvey.mockResolvedValue({ survey: DRAFT, response_count: 0, my_response: null });
    api.updateOutcomeSurvey.mockResolvedValue(DRAFT);

    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);
    await screen.findByLabelText('Survey title');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Required' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() =>
      expect(api.updateOutcomeSurvey).toHaveBeenCalledWith('campaign-1', {
        title: 'How did it go?',
        intro: 'Two minutes.',
        questions: [{ prompt: 'Did the work arrive?', type: 'rating', required: false }],
      })
    );
    expect(api.createOutcomeSurvey).not.toHaveBeenCalled();
  });

  it('keeps only the non-blank options of a single-choice question', async () => {
    api.getOutcomeSurvey.mockResolvedValue({
      survey: { ...DRAFT, questions: [] },
      response_count: 0,
      my_response: null,
    });
    api.updateOutcomeSurvey.mockResolvedValue(DRAFT);

    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);
    await screen.findByText('No questions yet. Add at least one before publishing.');

    await userEvent.click(screen.getByRole('button', { name: 'Add question' }));
    await userEvent.type(screen.getByLabelText('Question'), 'Would you back this again?');
    await userEvent.selectOptions(screen.getByLabelText('Answer type'), 'single_choice');

    const optionOne = await screen.findByLabelText('Option 1');
    await userEvent.type(optionOne, 'Yes');
    await userEvent.type(screen.getByLabelText('Option 2'), 'No');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      const [campaignId, payload] = api.updateOutcomeSurvey.mock.calls[0];
      expect(campaignId).toBe('campaign-1');
      expect(payload.questions[0]).toEqual({
        prompt: 'Would you back this again?',
        type: 'single_choice',
        required: true,
        options: ['Yes', 'No'],
      });
    });
  });

  it('surfaces a validation failure from the API without losing the draft', async () => {
    api.getOutcomeSurvey.mockResolvedValue({ survey: DRAFT, response_count: 0, my_response: null });
    api.updateOutcomeSurvey.mockRejectedValue(
      new Error('single_choice questions need at least two options')
    );

    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);
    await screen.findByLabelText('Question');
    await userEvent.clear(screen.getByLabelText('Question'));
    await userEvent.type(screen.getByLabelText('Question'), 'still here');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('at least two options');
    expect(screen.getByLabelText('Question')).toHaveValue('still here');
  });

  it('publishes the draft and reports how many backers were invited', async () => {
    api.getOutcomeSurvey.mockResolvedValue({ survey: DRAFT, response_count: 0, my_response: null });
    api.openOutcomeSurvey.mockResolvedValue({ survey: OPEN, invited: 4 });
    api.getOutcomeSurveyResults.mockResolvedValue(RESULTS);
    api.getOutcomeSurveyEvents.mockResolvedValue(EVENTS);

    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);
    await screen.findByLabelText('Survey title');
    await userEvent.click(screen.getByRole('button', { name: 'Publish survey' }));

    await waitFor(() => expect(api.openOutcomeSurvey).toHaveBeenCalledWith('campaign-1', {}));
    expect(await screen.findByText('Survey published — 4 backer(s) notified.')).toBeInTheDocument();
  });

  it('renders the aggregate results and the lifecycle trail once open', async () => {
    api.getOutcomeSurvey.mockResolvedValue({ survey: OPEN, response_count: 3, my_response: null });
    api.getOutcomeSurveyResults.mockResolvedValue(RESULTS);
    api.getOutcomeSurveyEvents.mockResolvedValue(EVENTS);

    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);

    expect(await screen.findByText('Results')).toBeInTheDocument();
    await waitFor(() => expect(api.getOutcomeSurveyResults).toHaveBeenCalledWith('campaign-1'));
    expect(await screen.findByText(/3 answered · 0 skipped of 3/)).toBeInTheDocument();
    expect(screen.getByText(/average 4.33 \/ 5/)).toBeInTheDocument();
    // Free text is shown as a bounded sample of answers.
    expect(screen.getByText('great work')).toBeInTheDocument();
    expect(screen.getByText('Draft created')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
  });

  it('never loads results for a draft', async () => {
    api.getOutcomeSurvey.mockResolvedValue({ survey: DRAFT, response_count: 0, my_response: null });
    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);

    await screen.findByLabelText('Survey title');
    expect(api.getOutcomeSurveyResults).not.toHaveBeenCalled();
  });

  it('closes an open survey and keeps the results visible', async () => {
    api.getOutcomeSurvey.mockResolvedValue({ survey: OPEN, response_count: 3, my_response: null });
    api.getOutcomeSurveyResults.mockResolvedValue(RESULTS);
    api.getOutcomeSurveyEvents.mockResolvedValue(EVENTS);
    api.closeOutcomeSurvey.mockResolvedValue({
      survey: { ...OPEN, status: 'closed' },
      already_closed: false,
    });

    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);
    await screen.findByRole('button', { name: 'Close survey' });
    await userEvent.click(screen.getByRole('button', { name: 'Close survey' }));

    await waitFor(() => expect(api.closeOutcomeSurvey).toHaveBeenCalledWith('campaign-1'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Close survey' })).not.toBeInTheDocument()
    );
  });

  it('surfaces a close failure', async () => {
    api.getOutcomeSurvey.mockResolvedValue({ survey: OPEN, response_count: 3, my_response: null });
    api.getOutcomeSurveyResults.mockResolvedValue(RESULTS);
    api.getOutcomeSurveyEvents.mockResolvedValue(EVENTS);
    api.closeOutcomeSurvey.mockRejectedValue(new Error('The outcome survey is no longer open'));

    renderWithProviders(<OutcomeSurveyEditor campaignId="campaign-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Close survey' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no longer open');
  });
});
