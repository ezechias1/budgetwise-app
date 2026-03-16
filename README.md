<p align="center">
  <img src="icons/icon-192.png" width="80" alt="BudgetWise Logo">
</p>

<h1 align="center">BudgetWise</h1>

<p align="center">
  <strong>A smart, modern budgeting app that helps you take control of your money.</strong><br>
  Track expenses, set savings goals, get personalized financial advice, and convert currencies — all in one place.
</p>

<p align="center">
  <a href="https://budget-wise-ruby.vercel.app"><strong>Try it live</strong></a>
</p>

---

![Login Page](screenshots/login-desktop.png)

## What is BudgetWise?

BudgetWise is a full-stack Progressive Web App (PWA) built for anyone who wants to understand where their money goes. Whether you're a student stretching a tight budget, a freelancer managing irregular income, or someone saving for something big — BudgetWise gives you the clarity and tools to make smarter financial decisions.

Sign up in seconds with email or Google, set your income and savings goal, and start logging expenses. BudgetWise does the rest — visualizing your spending, tracking your progress, and giving you actionable advice.

## Features

### Dashboard Overview
- Real-time stats with **animated counters** — income, spending, remaining balance, and savings goal
- **Spending by category** doughnut chart (click to drill down into daily breakdowns)
- **Income vs Expenses** bar chart
- **Savings goal progress** bar
- **6-month spending trends** line chart
- **Budget warnings** — set spending limits per category and get visual alerts at 70%, 90%, and 100%
- **Streak tracker** — see how many consecutive days you've logged expenses
- **Monthly summary** — automatic comparison vs last month

### Expense Tracking
- Log expenses with category, description, amount, date, and recurring flag
- **Search and filter** by category or keyword
- **Export to CSV** for spreadsheets
- **Custom categories** — create your own with custom colors
- **Recurring expenses** — mark expenses as monthly or weekly and they auto-populate each new month
- **Quick-add FAB** — floating action button on mobile for fast expense entry

### Savings Goals
- Create specific goals (laptop, car, holiday, etc.) with target amount, monthly contribution, and deadline
- Visual progress bars with smart advice per goal
- Track money added over time with a savings trend chart
- Confetti animation when you reach a goal

### Currency Converter
- Convert between **150+ world currencies** with live exchange rates
- Visual comparison chart showing your currency vs 10 major currencies
- Auto-detects your local currency from timezone

### Smart Advice
- **Salary Insight Calculator** — based on your spending, calculates what you should be earning (expenses + 20% emergency buffer + 15% savings)
- Personalized tips: overspending alerts, category warnings, 50/30/20 rule analysis
- Goal-specific advice with timeline estimates

### Account & Achievements
- Profile with avatar upload (cropped and stored locally)
- **9 achievement badges** — First Step, Tracker, Bookkeeper, Centurion, Goal Smasher, Budget Boss, Week Warrior, Monthly Master, Diversified
- Account details, quick stats, sign out, and delete all data

### Design & UX
- **Dark and light themes** with localStorage persistence and flash prevention
- **Installable PWA** — "Install App" button in mobile nav
- Fully responsive — desktop sidebar, mobile hamburger menu with overlay
- Glassmorphism dark theme with gradients, blur, and smooth animations
- **Zero frameworks** — built entirely with vanilla HTML, CSS, and JavaScript

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, CSS3, Vanilla JavaScript (ES Modules) |
| Backend | [Supabase](https://supabase.com) (Auth + PostgreSQL + Row Level Security) |
| Charts | [Chart.js 4.4](https://www.chartjs.org/) |
| Currency Rates | [ExchangeRate API](https://www.exchangerate-api.com/) |
| Deployment | [Vercel](https://vercel.com) (auto-deploy from GitHub) |
| PWA | Web App Manifest + Service Worker ready |

## Getting Started

### Quick Start (Use the live app)

1. Go to **[budget-wise-ruby.vercel.app](https://budget-wise-ruby.vercel.app)**
2. Sign up with email or Google
3. Set your currency, monthly income, and savings goal
4. Start logging expenses

### Self-Hosting

1. Create a project at [supabase.com](https://supabase.com)
2. Run the SQL below in the Supabase SQL Editor
3. Enable Google Auth in Authentication > Providers (requires Google Cloud OAuth credentials)
4. Copy your project URL and anon key into `js/supabase-config.js`
5. Deploy to Vercel or any static host

### Database Schema

```sql
create table user_settings (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null unique,
  currency text not null default 'ZAR',
  income numeric not null default 0,
  savings_goal numeric not null default 0,
  created_at timestamp with time zone default now()
);

create table expenses (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  category text not null,
  description text not null,
  amount numeric not null,
  date text not null,
  recurring text default 'no',
  created_at timestamp with time zone default now()
);

create table savings_goals (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  name text not null,
  target_amount numeric not null,
  saved_amount numeric not null default 0,
  monthly_contribution numeric not null default 0,
  deadline text,
  created_at timestamp with time zone default now()
);

create table custom_categories (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  name text not null,
  color text not null default '#10b981',
  created_at timestamp with time zone default now()
);

alter table user_settings enable row level security;
alter table expenses enable row level security;
alter table savings_goals enable row level security;
alter table custom_categories enable row level security;

create policy "Users manage own settings" on user_settings for all using (auth.uid() = user_id);
create policy "Users manage own expenses" on expenses for all using (auth.uid() = user_id);
create policy "Users manage own goals" on savings_goals for all using (auth.uid() = user_id);
create policy "Users manage own categories" on custom_categories for all using (auth.uid() = user_id);
```

## Project Structure

```
budget-wise/
  index.html          # Login / signup page
  dashboard.html      # Main app (single-page with sections)
  manifest.json       # PWA manifest
  css/
    auth.css          # Login page styles
    dashboard.css     # Dashboard styles (~2000 lines)
  js/
    auth.js           # Authentication logic
    app.js            # All app logic (~1600 lines)
    supabase-config.js # Supabase client init
  icons/
    icon-192.png      # PWA icon 192x192
    icon-512.png      # PWA icon 512x512
    icon-192.svg      # Source SVG
```

## Security

- All database tables use **Row Level Security (RLS)** — users can only access their own data
- Authentication via Supabase Auth (email/password with confirmation, Google OAuth)
- No sensitive data stored client-side (budget limits and avatar are localStorage only)
- Input validation on all forms

## Author

Built by **Ezechias** — [github.com/ezechias1](https://github.com/ezechias1)

---

<p align="center">
  <a href="https://budget-wise-ruby.vercel.app">
    <img src="https://img.shields.io/badge/Try%20BudgetWise-Live%20Demo-10b981?style=for-large-badge&logo=vercel&logoColor=white" alt="Live Demo">
  </a>
</p>
