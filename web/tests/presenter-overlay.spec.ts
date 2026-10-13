import {test,expect} from '@playwright/test';

// The former native-helper UI was deliberately removed from the pure-web build.
// Server-side legacy helper authentication/revocation retains its Go coverage.
test('meeting UI never asks users to install or pair a native helper', async ({page}) => {
 await page.goto('/');
 await expect(page.getByText(/WebZoomOverlay\.exe|生成助手配对信息/)).toHaveCount(0);
});
