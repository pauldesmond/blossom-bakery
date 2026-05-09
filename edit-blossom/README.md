# Blossom Editor — /edit-blossom/

Helen's content editor. Drop this whole folder into the repo root so it lives at:

  myblossombakery.co.uk/edit-blossom/editor.html

It loads the live site in an iframe (BASE_PATH='../') and lets Helen click-to-edit text and swap photos. Edits save to her browser's localStorage and export as a JSON draft for review.

Files:
- editor.html         — UI shell + styles
- editor-app.jsx      — React app (Babel-compiled in the browser)
- images/blossom_logo.png — favicon/brand mark

To use:
1. Helen visits the URL on her phone or laptop
2. Clicks any text on the live site → types → Enter to save
3. Clicks any photo → uploads replacement from her device
4. Hits "Save draft for review" → downloads blossom-draft-YYYY-MM-DD.json
5. Sends the JSON to Paul → Paul applies it to the repo and pushes
