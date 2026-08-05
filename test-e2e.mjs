import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const page = await browser.newPage();
const errors = [];
page.on('pageerror', err => errors.push(err.message));

// Go to the app
console.log('=== GOING TO APP ===');
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
console.log('Title:', await page.title());
console.log('URL:', page.url());
console.log('Page errors:', errors.length);

// Fill room name
const input = page.locator('input[placeholder="e.g. Monday Standup"]');
await input.fill('E2E Test Meeting');
console.log('\n=== FILLED ROOM NAME ===');

// Click Create Room (form button = nth(1))
const createBtns = page.locator('button:has-text("Create Room")');
await createBtns.nth(1).click();
console.log('=== CLICKED CREATE ROOM ===');

// Wait for navigation to meeting room
await page.waitForURL('**/meeting/**', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(2500);
console.log('\nNew URL:', page.url());

// Check the meeting room UI rendered
const content = await page.evaluate(() => document.body.innerText.substring(0, 800));
console.log('\n=== MEETING PAGE CONTENT ===');
console.log(content);

// Check for host/control bar elements
const hasControlBar = await page.locator('text=Leave').count() > 0 ||
                      await page.locator('button:has-text("Leave")').count() > 0;
console.log('\nHas Leave button:', hasControlBar);
const hasMeetingTitle = (await page.locator('text=E2E Test Meeting').count()) > 0 ||
                        (await page.locator('text=E2E').count()) > 0;
console.log('Meeting title visible:', hasMeetingTitle);

// Navigate to the lobby again
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
console.log('\nBack to lobby URL:', page.url());

await browser.close();
console.log('\n=== E2E COMPLETE ===');