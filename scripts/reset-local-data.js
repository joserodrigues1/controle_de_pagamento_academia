import fs from "fs";
import path from "path";
import process from "node:process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");

const dbFiles = [
  path.join(rootDir, "server", "data", "sports-center.db"),
  path.join(rootDir, "server", "sports-center.db"),
];
const uploadsDir = path.join(rootDir, "server", "uploads");

async function removeFile(filePath) {
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function resetUploadsDirectory(directoryPath) {
  await fs.promises.rm(directoryPath, { recursive: true, force: true });
  await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function main() {
  console.log("Iniciando limpeza local de banco e uploads...");
  console.log("Pare o backend antes de usar este comando.");

  let removedDatabases = 0;
  for (const dbFile of dbFiles) {
    if (await removeFile(dbFile)) {
      removedDatabases += 1;
      console.log(`Banco removido: ${path.relative(rootDir, dbFile)}`);
    }
  }

  await resetUploadsDirectory(uploadsDir);
  console.log(`Uploads resetados: ${path.relative(rootDir, uploadsDir)}`);

  console.log(`Limpeza concluída. Bancos removidos: ${removedDatabases}.`);
  console.log("Ao iniciar o backend novamente, a base será recriada e o admin padrão será restaurado.");
}

main().catch((error) => {
  console.error("Falha ao resetar os dados locais:", error);
  process.exitCode = 1;
});
