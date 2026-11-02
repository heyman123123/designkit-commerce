package config

import (
	"os"
	"strconv"
	"time"
)

// Config 汇集服务运行所需的环境配置。
type Config struct {
	Addr        string
	DBDriver    string // postgres | sqlite
	DSN         string
	JWTSecret   string
	AccessTTL   time.Duration
	RefreshTTL  time.Duration
	StorageDir  string
	AdminEmail  string
	AdminPass   string
	AutoMigrate bool
	PublicURL   string
	WorkerTick  time.Duration
	MaxUploadMB int64
	Env         string
	WebDir      string
	MobileDir   string
}

func Load() Config {
	return Config{
		Addr:        env("APP_ADDR", ":8080"),
		DBDriver:    env("DB_DRIVER", "sqlite"),
		DSN:         env("DB_DSN", "file:designkit.db?_pragma=busy_timeout(5000)"),
		JWTSecret:   env("JWT_SECRET", "dev-insecure-change-me"),
		AccessTTL:   envDuration("ACCESS_TTL", 30*time.Minute),
		RefreshTTL:  envDuration("REFRESH_TTL", 30*24*time.Hour),
		StorageDir:  env("STORAGE_DIR", "./data/storage"),
		AdminEmail:  env("ADMIN_EMAIL", ""),
		AdminPass:   env("ADMIN_PASSWORD", ""),
		AutoMigrate: envBool("AUTO_MIGRATE", true),
		PublicURL:   env("PUBLIC_URL", "http://localhost:8080"),
		WorkerTick:  envDuration("WORKER_TICK", 2*time.Second),
		MaxUploadMB: envInt("MAX_UPLOAD_MB", 25),
		Env:         env("APP_ENV", "dev"),
		WebDir:      env("WEB_DIR", "./web"),
		MobileDir:   env("MOBILE_DIR", "./mobile"),
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return b
}

func envInt(key string, fallback int64) int64 {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return fallback
	}
	return n
}

func envDuration(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return fallback
	}
	return d
}
