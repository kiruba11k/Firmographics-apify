# 🏢 Firmographic Enrichment Actor

Automatically enrich company data from website URLs using **Google SERP AI Mode** + **Groq LLM**.

Input a single URL or a CSV of URLs → Get structured firmographic data:

| Field | Example |
|---|---|
| `employee_min` / `employee_max` | 500 / 1000 |
| `revenue_min_usd` / `revenue_max_usd` | 10000000 / 50000000 |
| `funding_stage_include` | "series-b" |
| `founded_year_min` / `founded_year_max` | 2010 / 2010 |
| `company_status` | "active" |
| `total_funding_usd` | 150000000 |
| `industry` | "Fintech" |
| `headquarters` | "San Francisco, CA" |
| `notable_investors` | "Sequoia, Andreessen Horowitz" |
| `data_confidence` | "high" / "medium" / "low" |

---

## 🚀 Quick Start

### 1. Get Free API Keys

**SerpApi** (Google SERP):
- Sign up at https://serpapi.com
- Free tier: 100 searches/month
- Used for AI Overview + organic results

**Groq** (LLM):
- Sign up at https://console.groq.com  
- Free tier: generous rate limits
- Model: `llama-3.1-8b-instant` (fastest, free)

### 2. Configure Input

**Single URL:**
```json
{
  "websiteUrl": "https://stripe.com",
  "serpApiKey": "YOUR_SERPAPI_KEY",
  "groqApiKey": "YOUR_GROQ_KEY"
}
```

**CSV Batch:**
```json
{
  "csvFileUrl": "https://your-server.com/companies.csv",
  "csvColumnName": "website",
  "serpApiKey": "YOUR_SERPAPI_KEY",
  "groqApiKey": "YOUR_GROQ_KEY"
}
```

### 3. CSV Format
Your CSV just needs a column with website URLs:
```csv
website,company_name
https://stripe.com,Stripe
https://notion.so,Notion
```

---

## 📁 File Structure

```
firmographic-actor/
├── .actor/
│   ├── actor.json           # Actor metadata
│   └── input_schema.json    # Input field definitions + UI
├── src/
│   ├── main.js              # Actor entrypoint, orchestration
│   ├── serpService.js       # Google SERP API queries
│   ├── groqService.js       # Groq LLM extraction
│   └── csvUtils.js          # CSV parsing + output
├── storage/
│   └── key_value_stores/
│       └── default/
│           └── INPUT.json   # Local dev input
├── sample_input.csv         # Example CSV for batch mode
├── test_local.js            # Local test runner
├── Dockerfile               # Apify deployment container
├── package.json
└── README.md
```

---

## 🔄 How It Works

```
URL Input
    │
    ▼
SerpApi (3 queries per company)
    ├── "company.com employees revenue funding"
    ├── "company.com founded year funding stage raised"  
    └── "company.com headquarters industry sector"
    │
    ▼
Text aggregation
    ├── AI Overview blocks
    ├── Knowledge Graph attributes
    └── Organic result snippets
    │
    ▼
Groq LLM (llama-3.1-8b-instant)
    └── Structured JSON extraction
    │
    ▼
Output
    ├── Apify Dataset (streaming, per record)
    └── CSV file (Key-Value Store)
```

---

## 💻 Local Development

```bash
# Install dependencies
npm install

# Set env vars
export SERP_API_KEY=your_serpapi_key
export GROQ_API_KEY=your_groq_key

# Run local test (3 example companies)
node test_local.js

# Or run as full Apify actor locally
npx apify-cli run
```

---

## 📤 Output

### Apify Dataset
Every record is pushed to the dataset in real-time. Download as JSON, CSV, or XLSX from the Apify console.

### Key-Value Store CSV
A `firmographic_results.csv` file is saved to the actor's Key-Value Store.
Download URL format:
```
https://api.apify.com/v2/key-value-stores/{STORE_ID}/records/firmographic_results.csv
```

---

## ⚡ Performance Tips

- **Rate limits**: SerpApi free = 100 searches/month (3 per company = ~33 companies free)
- **Groq**: Very generous free tier, effectively unlimited for this use case
- **Concurrency**: Keep at 2-3 to avoid hitting SerpApi rate limits
- **Delay**: 1000ms between requests is safe for free tiers

## 🆓 Free Alternative APIs

| Purpose | Service | Free Tier |
|---|---|---|
| Web search | SerpApi | 100/month |
| Web search (alt) | ValueSERP | 100/month |
| LLM extraction | Groq | Very generous |
| LLM extraction (alt) | Together AI | $25 free credits |
| Company data | Clearbit (now HubSpot) | Limited free |

---

## 🛠 Deploying to Apify

```bash
# Install Apify CLI
npm install -g apify-cli

# Login
apify login

# Push to Apify
apify push

# Run on Apify cloud
apify call YOUR_USERNAME/firmographic-enrichment
```
