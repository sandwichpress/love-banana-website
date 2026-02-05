LOVE BANANA WEBSITE — MASTER PROJECT MANIFEST
SOURCE OF TRUTH
Mockups Folder: Love Banana Website mock ups (reference for all page designs)
Working Directory: /Users/henryhenry/Desktop/LB website 29:01:26/

ASSET MAP
images/LB logo (return home).png
images/Love Banana Logo.png
images/Page Headings.png
images/T-shirt Brown Variation #1.png
images/T-shirt Variation #3.png
images/T-shirt main Thumbnail.png
images/T-shirt variation #2.png
images/love banana poster.png
images/people everywhere.png
images/return home.png
images/returnhomguy2.png
images/Love Banana Guy .mp4
images/Love Banana logo.gif
CSS STYLE GUIDE
/* Core Values */
font-family: 'Courier New', Courier, monospace;
background-color: white;
color: black;
/* Borders */
border: 2px solid black;
/* Container */
width: 90%;
max-width: 1100px;
padding: 30px 40px;
/* Return Home Logo (Fixed Top-Right) */
position: fixed;
top: 20px;
right: 20px;
z-index: 100;
width: 120px;
PROTECTED
DO NOT MODIFY: index.html, video logic

GLOBAL REQUIREMENTS
Every sub-page: images/LB logo (return home).png linked to index.html in top-right (fixed position)
Remove ALL top-left navigation elements
Use 2px solid black borders for containers
E-COMMERCE INTEGRATION
Payment Processing
Platform: Stripe Checkout
Implementation: Each product detail page includes shipping form → submit triggers Stripe Checkout session
Setup Required: Stripe account, publishable/secret keys, product SKUs in Stripe Dashboard
Order Management
Dashboard: Stripe Dashboard (https://dashboard.stripe.com) — view all orders, customer details, payment status
Order Data: Customer name, address, email, product purchased, payment confirmation
Alternative: For advanced needs, webhook integration to store orders in database/spreadsheet
DEPLOYMENT PLAN
Step 1: GitHub Repository Setup
Create GitHub account at github.com (if needed)
Click "New Repository" → Name: love-banana-website
Keep it Public (required for free hosting)
DO NOT initialize with README
Copy the repository URL
Step 2: Upload Website Files
Option A - GitHub Web Interface (Easiest):

In your new repository, click "uploading an existing file"
Drag ALL files from /Users/henryhenry/Desktop/LB website 29:01:26/ folder
Add commit message: "Initial website upload"
Click "Commit changes"
Option B - VS Code (if comfortable):

Install Git: git --version (if not installed, download from git-scm.com)
In VS Code terminal: cd "/Users/henryhenry/Desktop/LB website 29:01:26"
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin [YOUR-REPO-URL]
git push -u origin main
Step 3: Enable GitHub Pages
In GitHub repo → Settings → Pages
Source: Deploy from a branch
Branch: main → Folder: / (root)
Click Save
Wait 2-3 minutes → Your site URL appears: https://[username].github.io/love-banana-website/
Step 4: Custom Domain (Optional)
Buy domain (e.g., from Namecheap, Google Domains)
In GitHub Pages settings → Custom domain: lovebanana.com
In domain registrar DNS settings, add:
Type: A → Host: @ → Value: 185.199.108.153
Type: A → Host: @ → Value: 185.199.109.153
Type: A → Host: @ → Value: 185.199.110.153
Type: A → Host: @ → Value: 185.199.111.153
Type: CNAME → Host: www → Value: [username].github.io
CONTENT MANAGEMENT (Easy Updates)
Option 1: Simple HTML Editing (No Setup Required)
For adding products:

Open merch.html in VS Code
Copy existing product <div class="merch-item">...</div> block
Paste below, update: image path, title, description, price
Save → commit → push to GitHub (auto-deploys in 1-2 min)
For adding shows:

Open shows.html
Copy existing <tr>...</tr> table row
Paste below, update: date, venue, location, ticket link
Save → commit → push
Option 2: Netlify CMS (Visual Admin Interface - Recommended)
Setup (one-time, ~15 min):

Move site from GitHub Pages → Netlify (free, easier updates)
Add admin/ folder to website with config.yml and index.html
Access admin at: yoursite.com/admin/
Login with GitHub → click "New Product" or "New Show"
Fill form → click Publish (instant update)
Benefits: No coding, visual editor, image upload, instant preview

Option 3: Google Sheets + API (Advanced)
Store products/shows in Google Sheet → website fetches data on page load. Requires JavaScript integration.

MICRO-PROMPTS FOR GEMINI
1. MERCH.HTML (Product Listing Page)
Create merch page with fixed top-right return home logo (images/LB logo (return home).png linked to index.html, CSS: position: fixed; top: 20px; right: 20px; z-index: 100; width: 120px;). Main container: width: 90%; max-width: 1100px; border: 2px solid black; padding: 30px 40px;. Grid layout (display: flex; flex-wrap: wrap; gap: 40px; justify-content: center;) with items: each item (max-width: 300px;) has 2px border box around image (border: 2px solid black; padding: 15px;), then underlined title (1.3rem), description (0.9rem), bold price (1.1rem), black button "BUY NOW" (links to product detail page). Use font-family: 'Courier New', Courier, monospace; and white background. Each product links to individual product page (e.g., product-tshirt.html).

2. PRODUCT DETAIL PAGE (e.g., product-tshirt.html)
Create product detail page with fixed top-right return home logo (images/LB logo (return home).png linked to index.html, CSS: position: fixed; top: 20px; right: 20px; z-index: 100; width: 120px;). Two-column layout (display: flex; gap: 40px;): LEFT COLUMN has 2px border box (border: 2px solid black; padding: 25px 30px;) containing large product image, underlined title (2rem), subtitle (0.9rem), description. RIGHT COLUMN has shipping form with fields: Name, Address, City, Postcode, Country (border: 2px solid black; padding: 10px; font-family: 'Courier New';), calculated total price display, and "BUY NOW" button.

CRITICAL - Stripe Integration: Button triggers JavaScript function that creates Stripe Checkout session. Add <script src="https://js.stripe.com/v3/"></script> to <head>. JavaScript: const stripe = Stripe('YOUR_PUBLISHABLE_KEY'); document.querySelector('.buy-button').addEventListener('click', async () => { const response = await fetch('/create-checkout-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: 'PRODUCT_SKU', shippingDetails: { name: document.querySelector('#name').value, address: document.querySelector('#address').value } }) }); const session = await response.json(); stripe.redirectToCheckout({ sessionId: session.id }); });

Note: Requires backend server (Node.js/Python) or serverless function (Netlify Functions) to create Stripe session with secret key. Simple implementation: use Stripe Payment Links (no code) — copy link from Stripe Dashboard → paste as button href.

3. SHOWS.HTML
Create shows page with fixed top-right return home logo (images/LB logo (return home).png linked to index.html, CSS: position: fixed; top: 20px; right: 20px; z-index: 100; width: 120px;). Center container width: 90%; max-width: 900px; margin-top: 30px;. Title "SHOWS" (font-size: 2.5rem; text-decoration: underline; letter-spacing: 5px;). Table (width: 100%; border-collapse: collapse;) with rows (border-bottom: 2px solid black;): columns for DATE, VENUE, LOCATION, TICKETS (black background button: background: black; color: white; padding: 5px 10px; text-decoration: none;). Use font-family: 'Courier New'; text-transform: uppercase; font-weight: bold; for table cells (padding: 20px 10px; font-size: 1.1rem;).

4. LINKS.HTML
Create links page with fixed top-right return home logo (images/LB logo (return home).png linked to index.html, CSS: position: fixed; top: 20px; right: 20px; z-index: 100; width: 120px;). Center wrapper width: 90%; max-width: 800px; margin-top: 40px; text-align: center;. Large underlined email link (font-size: 1.5rem; font-weight: bold; color: black; text-decoration: underline; display: block; margin-bottom: 50px;). Embedded YouTube iframe in 16:9 responsive container (position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden;) with iframe (position: absolute; top: 0; left: 0; width: 100%; height: 100%;). Use font-family: 'Courier New'; white background, black text.

5. GALLERY.HTML
Create gallery page with fixed top-right return home logo (images/LB logo (return home).png linked to index.html, CSS: position: fixed; top: 20px; right: 20px; z-index: 100; width: 120px;). Main container: width: 90%; max-width: 1100px; border: 2px solid black; padding: 30px 40px;. Welcome text (font-size: 1.1rem; margin-bottom: 30px;), then flex-wrap grid (display: flex; flex-wrap: wrap; gap: 40px;). Gallery items as clickable links (<a> tag, max-width: 280px; text-decoration: none; color: black;) containing: image (width: 100%; max-width: 280px; margin-bottom: 10px;), underlined title (font-size: 1.1rem; text-decoration: underline;), small description (font-size: 0.85rem;), bold price (font-size: 1rem; font-weight: bold;). Use font-family: 'Courier New';. Each item links to respective product detail page.