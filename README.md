# Tokko - Facebook Page Management

A Next.js application for managing Facebook Page contacts, tags, and messaging campaigns.

## Features

- 🔐 Facebook OAuth authentication
- 📱 Connect and manage multiple Facebook Pages
- 👥 Contact management with bulk operations
- 🏷️ Tag management for organizing contacts
- 📨 Campaign creation and bulk messaging
- 🔄 Automatic contact synchronization via webhooks
- 📊 Dashboard with statistics and insights

## Tech Stack

- **Framework:** Next.js 14.1.0 (App Router)
- **Authentication:** NextAuth.js
- **Database:** Supabase
- **Styling:** Tailwind CSS
- **Icons:** Lucide React

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Supabase account
- Facebook App credentials

### Installation

1. Clone the repository:
```bash
git clone https://github.com/princecjqlara/TOKKOdev.git
cd TOKKOdev
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
Create a `.env` file in the root directory:
```env
# NextAuth
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-key

# Facebook OAuth
FACEBOOK_CLIENT_ID=your-facebook-app-id
FACEBOOK_CLIENT_SECRET=your-facebook-app-secret
FACEBOOK_APP_SECRET=your-facebook-app-secret

# Supabase
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key

# Cron (optional)
CRON_SECRET=your-cron-secret
```

4. Set up the database:
Run the SQL schema from `database/schema.sql` in your Supabase SQL editor.

5. Run the development server:
```bash
npm run dev
```

6. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Facebook Setup

See `FACEBOOK_SETUP.md` for detailed instructions on setting up Facebook OAuth and webhooks.

## Project Structure

```
src/
├── app/
│   ├── api/              # API routes
│   ├── dashboard/       # Dashboard pages
│   ├── error.tsx        # Error boundary
│   ├── global-error.tsx # Global error boundary
│   └── not-found.tsx   # 404 page
├── components/          # React components
├── lib/                 # Utility functions
└── types/               # TypeScript types
```

## Development

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint

## License

Private project

## Repository

https://github.com/princecjqlara/TOKKOdev

