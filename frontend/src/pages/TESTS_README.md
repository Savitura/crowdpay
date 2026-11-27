# Page Tests - ReadingList & TaxReceipts

## Overview
This document describes the test suites for `ReadingList.jsx` and `TaxReceipts.jsx` added to resolve issue #1230.

## Test Files

### ReadingList.test.jsx
Tests the saved campaigns reading list page where users manage their favorited campaigns.

**Key Features Tested:**
- Loading and displaying saved campaigns
- Search functionality (title and category)
- Status filtering (all, active, funded, in_progress, completed)
- Removing campaigns from the reading list
- Toast notifications for success/error states
- Progress bars and formatted amounts
- Campaign status badges with styling
- Navigation to campaign detail pages

**API Methods Mocked:**
- `api.getFavorites()` - Fetches saved campaigns
- `api.removeFavorite(campaignId)` - Removes a campaign from favorites

**Context Mocked:**
- `useToast()` - Toast notification system

### TaxReceipts.test.jsx
Tests the tax receipts page where users view and download contribution receipts.

**Key Features Tested:**
- Loading and displaying tax receipts
- Individual receipt download (PDF)
- Bulk "Download all PDFs" functionality
- Download state management (preparing indicators)
- Error handling for download failures
- Display of receipt amounts, dates, and status
- Transaction links to Stellar Expert
- Campaign links for each receipt
- Proper DOM cleanup after downloads

**API Methods Mocked:**
- `api.getTaxReceipts()` - Fetches all receipts
- `api.downloadTaxReceiptPdf(id)` - Downloads single receipt PDF
- `api.downloadTaxReceiptsPdf()` - Downloads all receipts as single PDF

**DOM APIs Mocked:**
- `document.createElement()` - For download link creation
- `URL.createObjectURL()` - For blob URL generation
- `URL.revokeObjectURL()` - For cleanup

## Running Tests

### Run All Page Tests
```bash
cd frontend
npm test
```

### Run Specific Test Files
```bash
# ReadingList tests only
npm test ReadingList.test.jsx

# TaxReceipts tests only
npm test TaxReceipts.test.jsx

# Both new tests
npm test ReadingList.test.jsx TaxReceipts.test.jsx
```

### Watch Mode (Auto-rerun on changes)
```bash
npm run test:watch
```

### Run with Coverage
```bash
npm test -- --coverage
```

## Test Structure

Both test files follow the project's established patterns:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock dependencies before importing component
vi.mock('../services/api', () => ({ ... }));

// Import after mocks
import { api } from '../services/api';
import Component from './Component';

describe('Component', () => {
  beforeEach(() => {
    // Reset mocks before each test
  });

  it('test description', async () => {
    // Arrange: Setup mocks
    api.someMethod.mockResolvedValue({ data: [...] });
    
    // Act: Render component and interact
    render(<Component />);
    await user.click(screen.getByRole('button'));
    
    // Assert: Verify behavior
    await waitFor(() => {
      expect(screen.getByText('Expected Text')).toBeInTheDocument();
    });
    expect(api.someMethod).toHaveBeenCalledWith('param');
  });
});
```

## Common Patterns

### Waiting for Async Operations
```javascript
await waitFor(() => {
  expect(screen.getByText('Loaded Content')).toBeInTheDocument();
});
```

### User Interactions
```javascript
const user = userEvent.setup();
await user.type(screen.getByPlaceholderText('Search'), 'query');
await user.click(screen.getByRole('button', { name: /download/i }));
await user.selectOptions(screen.getByRole('combobox'), 'active');
```

### Testing Loading States
```javascript
// Mock a never-resolving promise
api.getData.mockReturnValue(new Promise(() => {}));
render(<Component />);
expect(screen.getByText(/loading/i)).toBeInTheDocument();
```

### Testing Error States
```javascript
api.getData.mockRejectedValue(new Error('Network error'));
render(<Component />);
await waitFor(() => {
  expect(screen.getByText(/could not load/i)).toBeInTheDocument();
});
```

### Testing Downloads
```javascript
const mockBlob = new Blob(['content'], { type: 'application/pdf' });
api.downloadPdf.mockResolvedValue({
  blob: mockBlob,
  filename: 'receipt.pdf',
});

// Mock DOM methods
const clickSpy = vi.fn();
vi.spyOn(document, 'createElement').mockReturnValue({
  click: clickSpy,
  remove: vi.fn(),
});
vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:url');

await user.click(screen.getByRole('button', { name: /download/i }));

await waitFor(() => {
  expect(clickSpy).toHaveBeenCalled();
});
```

## Debugging Tests

### View Test Output
Tests output to console. Look for:
- Failed assertions with expected vs actual values
- API mock call information
- Rendering errors

### Common Issues

**Issue: "Unable to find element"**
```javascript
// Use screen.debug() to see rendered HTML
render(<Component />);
screen.debug();

// Or use queries that show available roles
screen.getByRole('button'); // Shows all available buttons if not found
```

**Issue: "API method not called"**
```javascript
// Check the mock was called
console.log(api.method.mock.calls);
// Check you're waiting for async operations
await waitFor(() => { ... });
```

**Issue: "Test timeout"**
```javascript
// Increase timeout for slow operations
await waitFor(
  () => { expect(...).toBeInTheDocument(); },
  { timeout: 5000 }
);
```

## Test Coverage Goals

### ReadingList.jsx ✅
- [x] Load favorites from API
- [x] Display empty state
- [x] Search by title
- [x] Search by category
- [x] Filter by status
- [x] Remove from favorites
- [x] Show success/error toasts
- [x] Display progress bars
- [x] Format amounts correctly
- [x] Render navigation links

### TaxReceipts.jsx ✅
- [x] Load receipts from API
- [x] Display empty state
- [x] Show error messages
- [x] Download individual receipt
- [x] Download all receipts
- [x] Show download progress state
- [x] Handle download errors
- [x] Display amounts and dates
- [x] Render transaction links
- [x] Render campaign links
- [x] Clean up DOM after downloads

## Integration with CI/CD

These tests run automatically in the CI pipeline:
1. On pull request creation
2. On push to main/develop branches
3. As part of pre-commit hooks (if configured)

The build will fail if any test fails, ensuring code quality.

## Maintenance

### Adding New Tests
1. Follow existing patterns in `ReadingList.test.jsx` and `TaxReceipts.test.jsx`
2. Mock all external dependencies
3. Test user-visible behavior, not implementation details
4. Include edge cases (empty states, errors, null values)

### Updating Tests After Component Changes
1. If component behavior changes, update relevant tests
2. If new features are added, add corresponding tests
3. Run tests locally before pushing: `npm test`

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/react)
- [User Event API](https://testing-library.com/docs/user-event/intro)
- [Jest DOM Matchers](https://github.com/testing-library/jest-dom)

## Questions?

If you encounter issues with these tests:
1. Check the test output for specific error messages
2. Use `screen.debug()` to inspect rendered content
3. Verify mocks are properly configured
4. Check that async operations use `waitFor()`
