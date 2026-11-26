import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import ImpactReportDisplay from '../../components/campaign/ImpactReportDisplay';

describe('ImpactReportDisplay', () => {
  it('renders formatted report content without interpreting unsafe HTML', () => {
    render(
      <ImpactReportDisplay
        campaignTitle="Community garden"
        report={{
          title: 'What we achieved',
          summary: 'A successful season',
          publishedAt: '2026-04-15T12:00:00Z',
          content: '## Results\n\n**Impact:** 40 gardens\n\n<img src=x onerror=alert(1)>',
          viewsCount: 12,
        }}
      />
    );

    expect(screen.getByRole('heading', { name: 'What we achieved' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Results', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('Impact:', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
    expect(document.querySelector('[onerror]')).not.toBeInTheDocument();
  });

  it('displays the view metric with singular and plural labels', () => {
    const { rerender } = render(
      <ImpactReportDisplay
        campaignTitle="Community garden"
        report={{ title: 'Report', publishedAt: '2026-04-15', viewsCount: 1 }}
      />
    );

    expect(screen.getByText('1 view')).toBeInTheDocument();

    rerender(
      <ImpactReportDisplay
        campaignTitle="Community garden"
        report={{ title: 'Report', publishedAt: '2026-04-15', viewsCount: 3 }}
      />
    );

    expect(screen.getByText('3 views')).toBeInTheDocument();
  });

  it('renders no section when the report is missing', () => {
    const { rerender, container } = render(
      <ImpactReportDisplay campaignTitle="Community garden" />
    );

    expect(container.firstChild).toBeNull();

    rerender(<ImpactReportDisplay campaignTitle="Community garden" report={null} />);

    expect(container.firstChild).toBeNull();
  });

  it('omits optional sections when the report has no content or media', () => {
    render(
      <ImpactReportDisplay
        campaignTitle="Community garden"
        report={{ title: 'Brief update', publishedAt: '2026-04-15', content: '', viewsCount: 0 }}
      />
    );

    const section = screen.getByRole('region', { name: 'Brief update' });
    expect(section).toBeInTheDocument();
    expect(within(section).queryByText('📸 Gallery')).not.toBeInTheDocument();
    expect(within(section).queryByText('🎬 Videos')).not.toBeInTheDocument();
    expect(within(section).queryByText('🎯')).not.toBeInTheDocument();
    expect(within(section).getByText('0 views')).toBeInTheDocument();
  });
});
