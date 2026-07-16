import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyPluginAsync } from "fastify";


const jwtPlugin: FastifyPluginAsync = async (app) =>{
    await app.register(fastifyJwt, {
        secret: process.env.JWT_SECRET!,
    });
}

export default fp(jwtPlugin);