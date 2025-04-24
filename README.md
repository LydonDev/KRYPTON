# KRYPTON

Krypton the daemon for Kyro that runs on your nodes that allows for server management to actually work.

---

## Features
- **Fast backend** powered by Bun
- **Integrated CLI** for migrations, database management, and utilities
- **SQLite** database (easy to set up, portable)
- **Modern UI/UX** (frontend in `/core`)
- **Full authentication** with JWT and email verification (Resend API)
- **Role-based permissions** and access control
- **Server management** (create, update, power actions, etc.)
- **Project, node, and unit management**

---

## Getting Started

### Prerequisites
- [Bun](https://bun.sh) (v1.2.10 or newer)
- [Node.js](https://nodejs.org) (for some frontend dependencies)
- [Docker](https://www.docker.com) (optional, for running containers)
- [Git](https://git-scm.com) (for version control)
- [Unzip](https://www.info-zip.org/UnZip.html) (for extracting files)
- [Resend API key](https://resend.com) (for email verification)

### Installation
1. **Clone the repositories:**

   ```bash
   git clone https://github.com/LydonDev/KRYPTON.git
   git clone https://github.com/LydonDev/KYRO.git
   ```
2. **Install dependencies:**

   ```bash
   cd KRYPTON
   bun install
   cd ../KYRO
   bun install
   cd core
   bun install
   ```
3. **Copy environment variables:**

   ```bash
   cd ../KRYPTON
   cp .env.example .env
   cd ../KYRO
   cp .env.example .env
   cd core
   cp .env.example .env
   ```
4. **Run migrations:**

   ```bash
   cd ../KYRO
   kyro unit seed
   kyro migrate --force
   ```
5. **Run the application:**
   - **Development:**

     ```bash
     kyro dev
     ```
   - **Production:**

     ```bash
     kyro prod
     ```
6. **Configure Krypton:**

   ```bash
   cd ../KRYPTON
   bun run configure
   ```

---

## Usage
- Access the UI at [http://localhost:5173](http://localhost:5173) (default)
- Use the CLI (`kyro`) for migrations, DB management, and utilities
- Authenticate via email (verification required)
- Manage servers, projects, nodes, units from the web UI or API

---

## Configuration
- **.env** files are required in both `KYRO` and `KRYPTON` directories. Example files are provided as `.env.example`.
- **Resend API Key** is required for email verification (set `RESEND_API_KEY` in `.env`).
- **APP_URL** should be set for correct email links.

---

## Authentication & Permissions
- JWT-based authentication
- Email verification required (Resend integration)
- Role-based permissions (admin & user)
- Password reset and email notifications

---

## CLI Commands
- `kyro migrate --force` - Run all pending migrations
- `kyro dev` - Start backend and frontend in development mode
- `kyro prod` - Build and start in production mode
- More utilities available via `kyro` CLI (see `src/cli/cli.ts` for details)

---

## License
(C) This dashboard is provided free of charge, with no warranties, support, or liability. You are welcome to use, modify, and share this project for any purpose, commercial or non-commercial. Attribution is appreciated but not required. Please respect the spirit of open source—do not sell this project as your own proprietary work.

---

