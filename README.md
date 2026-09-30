# Revision Time Calculator

A Chrome extension that totals working time from Google Sheets cells written in `HH.MM` notation.

`1.17` means **1 hour 17 minutes**. It does not mean 1.17 decimal hours.

The calculator is a floating panel inside the spreadsheet. It stays open while you select cells. It is not a toolbar popup, because a popup closes as soon as you click back into the sheet.

## What it does

1. You open a Google Sheet and click the extension icon.
2. A calculator appears in the bottom-right corner.
3. You add hour cells with a single click.
4. The panel shows those times on one line, like `0.17 + 0.12 + 0.03`, and updates the total immediately.
5. The copy icon places the total on the clipboard as `145 minutes (2.42 hours)`.

Example:

| Cell | Meaning | Minutes |
| --- | --- | --- |
| 1.17 | 1h 17m | 77 |
| 0.33 | 0h 33m | 33 |
| 0.25 | 0h 25m | 25 |
| 0.10 | 0h 10m | 10 |
| **Total** | **2h 25m** | **145** |

The panel shows minutes and `2.42 hours`.

## Browser and site

- Chrome 114 or newer (Manifest V3, ES modules)
- `https://docs.google.com/spreadsheets/*` only

The extension does not inject itself into other websites.

## Install (Load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Choose the `sheet-time-calculator` folder (the folder that contains `manifest.json`).
5. Pin **Revision Time Calculator** if you want the icon visible.

There is no build step.

## How to use

1. Open the spreadsheet.
2. Click the extension icon. The badge shows `ON`.
3. Click an hour cell to add its time. Shift+click and Alt+click stay with Google Sheets.
4. Click the same value again to add it a second time. Click a number in the panel to remove that one entry.
5. The selected times appear on one line, like `0.17 + 0.12 + 0.03`. The large number under that line is total minutes. Cell addresses are not shown.
6. Copy places `236 minutes (3.93 hours)` on the clipboard. The top buttons choose where the time goes: **Revision** (default), **Feedback**, or **Checking**. The bottom button follows that choice: **Add to Revision**, **Add Feedback**, or **Add Checking**. It opens the [detailed report](https://report-generator-pearl-two.vercel.app/detailed-report) and, after you dismiss any name prompt, types the total minutes into Revision, Feedback Response, or Review.
7. Click the chip to open the panel again. × on the chip turns the extension off.
8. Optional shortcut: **Alt+Shift+S** toggles the extension. Change it in `chrome://extensions/shortcuts`.

## Time format

Hours are the digits before the decimal point. Minutes are the digits after it.

| Typed value | Result |
| --- | --- |
| `3.13` | 3h 13m = 193 minutes |
| `0.08` | 8 minutes |
| `0.03` | 3 minutes |
| `1` or `1.0` | 1h 0m = 60 minutes |
| `0` | 0 minutes |
| `0.67` | 67 minutes = 1h 7m |
| `1.75` | 1h 75m = 2h 15m = 135 minutes |
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

A minute part of 60 or more is still counted. `0.67` is 67 minutes, shown as `1h 7m` and included in the total. Words such as `Completed` stay out of the total.

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

A normal click is not cancelled, so Sheets keeps its own selection behavior. The extension keeps a separate list.

Changing to another sheet tab clears the selection. Cells from two sheets are not mixed.

## Known limitations

- Only single cells are accepted. A dragged range (`H150:H160`) or a whole column is ignored.
- Formula results are not visible in the formula bar, and the extension will not copy the clipboard to discover them.
- Very fast modifier-clicks can collapse into the last cell, because Sheets only exposes the active cell after each click. Pause briefly between clicks.
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
| “Could not read this cell.” | Click the cell again. If the formula bar shows `=...`, select the source hour cell instead. |
| A value looks wrong | Read the row’s `value → duration` line. Remove it with × if Sheets dropped a zero you did not intend. |
| `0.67` looks too large | `0.67` is 67 minutes (`1h 7m`), not 0.67 decimal hours. |
| Panel is in the way | Drag the header, or press the close icon. × on the chip turns it off. |
| Selection disappeared | Switching sheet tabs clears it on purpose. |
| Styles look like Google’s UI | Reload the extension. The panel is a light neomorphic card, isolated in shadow DOM. |
