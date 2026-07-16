import app from "./app.js";
import "dotenv/config";

const start = async () => {
  try {
    await app.listen({
      port: 3001,
      host: "0.0.0.0",
    });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();