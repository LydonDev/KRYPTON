import config from "../config.json";

type AppConfig = {
    app: {
        url: string;
        port: number;
        domain: string;
        name: string;
        first_user_has_admin: boolean;
        version: string;
    };
    api: {
        port: number;
        url: string;
    };
};

const typedConfig = config as AppConfig;

export const APP_URL = typedConfig.app.url;
export const APP_PORT = typedConfig.app.port;
export const APP_DOMAIN = typedConfig.app.domain;
export const APP_NAME = typedConfig.app.name;
export const FIRST_USER_HAS_ADMIN = typedConfig.app.first_user_has_admin;
export const KYRO_VERSION = typedConfig.app.version;
export const API_PORT = typedConfig.api.port;
export const API_URL = typedConfig.api.url;

