# Sheet Time Calculator

A Chrome extension that totals working time from Google Sheets cells written in `HH.MM` notation.

`1.17` means **1 hour 17 minutes**. It does not mean 1.17 decimal hours.

The calculator is a floating panel inside the spreadsheet. It stays open while you select cells. It is not a toolbar popup, because a popup closes as soon as you click back into the sheet.

## What it does

1. You open a Google Sheet and click the extension icon.
2. A calculator appears in the bottom-right corner.
3. You add hour cells with Ctrl+Click (Windows/Linux) or ⌘+Click (macOS).
4. The panel lists each cell, parses it, and updates the total immediately.
5. You copy the total minutes, the hours-and-minutes line, or a short report.

Example:

| Cell | Meaning | Minutes |
| --- | --- | --- |
| 1.17 | 1h 17m | 77 |
| 0.33 | 0h 33m | 33 |
| 0.25 | 0h 25m | 25 |
| 0.10 | 0h 10m | 10 |
| **Total** | **2h 25m** | **145** |
| Decimal hours | 145 ÷ 60 | **2.42** |

These three forms are always labeled separately:

- Spreadsheet `HH.MM`: `2.15` would mean 2 hours 15 minutes
- Duration: `2h 15m`
- Decimal hours: `2.25`
- Minutes: `135 minutes`

## Browser and site

- Chrome 114 or newer (Manifest V3, ES modules)
- `https://docs.google.com/spreadsheets/*` only

The extension does not inject itself into other websites.

## Install (Load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Choose the `sheet-time-calculator` folder (the folder that contains `manifest.json`).
5. Pin **Sheet Time Calculator** if you want the icon visible.

There is no build step.

## How to use

1. Open the spreadsheet.
2. Click the extension icon. The badge shows `ON`.
3. Click an hour cell normally to see it as the active candidate. A normal click does not add it.
4. Hold the modifier and click the cell to add it:
   - Windows / Linux: **Ctrl + Click**
   - macOS: **⌘ + Click**
5. Modifier-click the same cell again to remove it.
6. Use **×** on a row to remove that cell, **Clear All** to empty the list, or **Stop** to turn the extension off.
7. The header **×** minimizes the panel to a small `STC` chip. Click the chip to open it again. Selection mode stays on.
8. **Pause** keeps the panel open but ignores new clicks. **Resume** turns selection back on.
9. **Add active cell** adds whatever cell is currently selected. Use this if a click is not detected.
10. Optional shortcut: **Alt+Shift+S** toggles the extension. Change it in `chrome://extensions/shortcuts`.

Copy buttons:

| Button | Clipboard |
| --- | --- |
| Copy Minutes | `145` |
| Copy Time | `145 minutes (2h 25m)` |
| Copy Report | Sheet name, each cell, total, and decimal hours |

## Time format

Hours are the digits before the decimal point. Minutes are the digits after it.

| Typed value | Result |
| --- | --- |
| `3.13` | 3h 13m = 193 minutes |
| `0.08` | 8 minutes |
| `0.03` | 3 minutes |
| `1` or `1.0` | 1h 0m = 60 minutes |
| `0` | 0 minutes |
| `1.60`, `1.75`, `0.75` | Invalid. Shown with a warning and excluded from the total |
| `Completed`, blank | Not added |

### Trailing zeros

Google Sheets stores these cells as numbers. A trailing zero disappears:

- `0.50` is shown as `0.5`
- `0.10` is shown as `0.1`
- `2.40` is shown as `2.4`

On the source workbook, single-digit minutes are already written with a leading zero (`0.05` = 5 minutes, `0.08` = 8 minutes). A one-digit fraction is therefore the tens digit that Sheets dropped:

- `0.5` → 50 minutes
- `0.1` → 10 minutes
- `2.4` → 2 hours 40 minutes

The panel shows the interpretation (`2.4 → 2h 40m`) so you can remove a cell if it was not what you meant.

Minutes of 60 or more are never silently converted. `1.75` stays in the list with **Invalid time format: 1.75** and is left out of the total.

## Privacy and security

- No server, account, analytics, or remote script.
- Cell values stay in memory for the current page session.
- `chrome.storage.local` stores only the panel position and size.
- Permissions are `storage`, `scripting`, `activeTab`, and `https://docs.google.com/spreadsheets/*`.
- The panel uses a closed shadow DOM, so its styles do not affect Sheets and Sheets styles do not affect it.
- The extension never reads or overwrites the clipboard except when you press a copy button.

## How cell reading works

Google Sheets draws the grid on a canvas. The cells are not `<td>` elements, so the extension does not scrape the grid.

After Sheets handles a click, two stable controls update:

1. The name box (`#t-name-box`) — the address, such as `H150`.
2. The formula bar (`#t-formula-bar-input`) — the value that was entered.

All of that logic is isolated in `src/content/cell-reader.js` (`SheetAdapter`). If Google changes the DOM, that file is the place to update.

The formula bar shows a formula, not its result. A cell such as `=H7+M7` cannot be totaled. Select the typed hour cells instead. The panel says **Could not read this cell** rather than guessing.

Ctrl/⌘+Click is not cancelled, so Sheets keeps its own selection behavior. The extension keeps a separate list.

Changing to another sheet tab clears the selection. Cells from two sheets are not mixed.

## Known limitations

- Only single cells are accepted. A dragged range (`H150:H160`) or a whole column is ignored.
- Formula results are not visible in the formula bar, and the extension will not copy the clipboard to discover them.
- Very fast modifier-clicks can collapse into the last cell, because Sheets only exposes the active cell after each click. Pause briefly between clicks, or use **Add active cell**.
- The name box and formula bar are the supported reading path. If a future Sheets UI removes them, selection will report that the cell could not be read.
- The live Google Sheet linked during development required a sign-in, so the time rules were checked against the downloaded workbook’s September man-hour columns (values such as `0.08`, `0.17`, `1.25`, and `2.4`).

## Development

```bash
cd sheet-time-calculator
npm test
```

`npm test` runs the parser, calculator, selection, and address tests with Node’s built-in test runner. No packages are installed.

Layout:

```text
sheet-time-calculator/
├── manifest.json
├── src/
│   ├── background/service-worker.js
│   ├── content/
│   │   ├── content.js              state machine and events
│   │   ├── cell-reader.js          Google Sheets DOM adapter
│   │   ├── time-parser.js          HH.MM parser
│   │   ├── calculator.js           minute totals and formats
│   │   ├── selection-manager.js
│   │   ├── floating-panel.js
│   │   └── styles.css
│   └── shared/constants.js
├── icons/
└── tests/time.test.mjs
```

States:

- **Inactive** — no panel and no grid listener.
- **Active** — panel visible, modifier-clicks toggle cells.
- **Paused** — panel visible, clicks are ignored.

Clicking the extension icon activates an inactive session and deactivates an active or paused one.

## Troubleshooting

| What you see | What to try |
| --- | --- |
| Icon click does nothing | Confirm the tab URL starts with `https://docs.google.com/spreadsheets/`. Reload the sheet after installing. |
| “Could not read this cell.” | Click the cell, then press **Add active cell**. If the formula bar shows `=...`, select the source hour cell instead. |
| A value looks wrong | Read the row’s `value → duration` line. Remove it with × if Sheets dropped a zero you did not intend. |
| `Invalid time format: 1.75` | The minutes part is 75. The cell is excluded until you remove it or fix the sheet. |
| Panel is in the way | Drag the header, or press × to minimize. **Stop** removes it. |
| Selection disappeared | Switching sheet tabs clears it on purpose. |
| Styles look like Google’s UI | Reload the extension. The panel should be a dark terminal-style card, isolated in shadow DOM. |
