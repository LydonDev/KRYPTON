> [!CAUTION]
> Kyro is under active development and may be unstable.

# Kyro ⚡️

**Modern, High-Performance Server Management**

![Bun](https://img.shields.io/badge/Bun-1.2.10+-black?style=for-the-badge&logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)

---

## 📖 Overview

Kyro is a high-performance, modern, and user-friendly server management platform—an alternative to Pterodactyl—designed for speed, reliability, and great UX. It features a fast Bun backend, modern Vite-powered frontend, integrated CLI, role-based permissions, and more.

---

## 🎁 Dependencies

- [Bun](https://bun.sh) 
- [Node.js](https://nodejs.org) 
- [Docker](https://www.docker.com) 
- [Git](https://git-scm.com)
- [Unzip](https://www.info-zip.org/UnZip.html)
- [Resend API key](https://resend.com) 

---

## 💾 Installation

1. **Clone the repositories:**
   ```bash
   git clone https://github.com/LydonDev/KRYPTON.git
   git clone https://github.com/LydonDev/KYRO.git
   ```
2. **Install dependencies in each repo:**
   ```bash
   cd KRYPTON
   bun add .
   bun link
   bun install
   cd ../KYRO
   bun add .
   bun link
   bun install
   ```
3. **Database Setup:**
   ```bash
   kyro bolt migrate --force
   kyro user:create
   kyro unit seed
   ```
4. **Configure environment:**
   - Copy `example.config.json` to `config.json` in each repo and fill in required values.

---

## 🚀 Running Kyro

1. **Start the backend:**
   ```bash
   kyro production
   ```
2. **Configure krypton & start it**
   ```bash
   cd KRYPTON
   bun run configure
   bun run start
   ```

---

## 🧩 Features

- ⚡️ Fast backend powered by Bun
- 🛠 Integrated CLI for migrations, database, and utilities
- 🐱‍🏍 SQLite database (portable, easy setup)
- 🎨 Modern UI/UX (Vite frontend in `/core`)
- 🔒 Full authentication (JWT, email verification)
- 🧑‍💼 Role-based permissions and access control
- 🖥 Server, project, node, and unit management
- 📦 Easy deployment and migration tools

---

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

**Contribution Guidelines:**

- Follow Bun/TypeScript best practices
- Maintain clean, readable code
- Update documentation as needed

---

## ❓ FAQ

- **Kyro feels slow or laggy!**

  - Clear your browser cache/cookies, ensure you are running in production mode, and check your system resources. Running on older hardware or with too many background processes may impact speed.

- **How do I change the panel's name?**

  - Set the `name` variable in all `config.json` files to your desired name. This will also rename all Kyro commands and require you to stop all running Kyro processes and rename your Kyro database accordingly.

- **Can I install a theme or plugins?**

  - Not at this time. Kyro does not currently support themes or plugins. To customize the look, you must manually edit the frontend files.

- **How do I set up email verification?**

  - Register a Resend account for an API key and link your domain to Resend. This enables email verification for user registration and password resets.

- **The application won't start. What should I check?**

  - Ensure all dependencies are installed with `bun install` in each repo (`KRYPTON`, `KYRO`, and `core`). Verify your `.env` files are present and correctly configured. Check the logs with `kyro logs` for specific errors.

- **How do I contribute to Kyro?**

  - Fork the repository, create a new branch, and submit a pull request. Ensure your code follows the existing style and includes tests where appropriate.

- **How do I update Kyro to the latest version?**

  - Pull the latest changes from the repository, reinstall dependencies with `bun install`, and run any new migrations with `kyro migrate --force`.

- **Where can I get help or report bugs?**
  - Open an issue on the GitHub repository or check the Discussions section for community support.

---

## 📄 License

(C) This dashboard is provided free of charge, with no warranties, support, or liability. You are welcome to use, modify, and share this project for any purpose, commercial or non-commercial. Attribution is appreciated but not required. Please respect the spirit of open source—do not sell this project as your own proprietary work.

## 🌹 Credits

- [Argon](https://github.com/argon-foss)
- [Pterodactyl](https://github.com/pterodactyl)
- [Airlink](https://github.com/airlinklabs)
- [Octant](https://discord.gg/compute)
- [Pyro](https://github.com/pyrohost/pyrodactyl)

<div align="center">
  Made with ❤️ by Lydon
</div>
