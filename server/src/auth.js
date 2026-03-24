import jwt from "jsonwebtoken";
import process from "node:process";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
export const USING_DEFAULT_JWT_SECRET = JWT_SECRET === "dev-secret-change-me";

export const signToken = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });

export function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token ausente" });
  }

  const token = header.replace("Bearer ", "");
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ message: "Token invalido ou expirado" });
  }
}

export function adminRequired(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Acesso restrito ao administrador" });
  }
  return next();
}
