// Package webui 托管 Web 工作台、管理后台与移动端 PWA 的静态资源。
//
// 三个入口都是零构建的 ES Module 应用，由 Go 直接提供文件；
// 页面使用 hash 路由，因此任何未知路径都回退到对应入口的 index.html。
package webui

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Mount 把三个前端入口挂到根路由上。
func Mount(r interface {
	Get(string, http.HandlerFunc)
	Handle(string, http.Handler)
}, webDir, mobileDir string) {
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		http.Redirect(w, req, "/app/", http.StatusFound)
	})
	r.Handle("/app/*", SPA(filepath.Join(webDir, "app"), "/app/"))
	r.Handle("/assets/*", Static(filepath.Join(webDir, "assets"), "/assets/"))
	r.Handle("/admin/*", SPA(filepath.Join(webDir, "admin"), "/admin/"))
	r.Handle("/m/*", SPA(mobileDir, "/m/"))
}

// SPA 提供单页应用文件，未命中的路径回退到 index.html。
func SPA(root, prefix string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		rel := strings.TrimPrefix(r.URL.Path, prefix)
		rel = strings.TrimPrefix(rel, "/")
		if rel == "" {
			serveIndex(w, r, root)
			return
		}
		clean := path.Clean("/" + rel)
		full := filepath.Join(root, filepath.FromSlash(clean))
		if relPath, err := filepath.Rel(root, full); err != nil || strings.HasPrefix(relPath, "..") {
			http.NotFound(w, r)
			return
		}
		if st, err := os.Stat(full); err == nil && !st.IsDir() {
			setCache(w, clean)
			http.ServeFile(w, r, full)
			return
		}
		// 带扩展名的静态资源缺失时直接 404，避免把 JS 请求回退成 HTML。
		if path.Ext(clean) != "" {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r, root)
	})
}

// Static 提供目录静态资源。
func Static(dir, prefix string) http.Handler {
	fs := http.StripPrefix(prefix, http.FileServer(http.Dir(dir)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, prefix)
		if p != "" {
			setCache(w, p)
		}
		fs.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, root string) {
	idx := filepath.Join(root, "index.html")
	if _, err := os.Stat(idx); err != nil {
		http.Error(w, "前端资源未部署", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeFile(w, r, idx)
}

func setCache(w http.ResponseWriter, p string) {
	switch {
	case strings.HasSuffix(p, ".html"):
		w.Header().Set("Cache-Control", "no-cache")
	case strings.HasSuffix(p, ".js"), strings.HasSuffix(p, ".css"):
		w.Header().Set("Cache-Control", "public, max-age=60")
	case strings.HasSuffix(p, ".webmanifest"):
		w.Header().Set("Content-Type", "application/manifest+json")
		w.Header().Set("Cache-Control", "public, max-age=300")
	default:
		w.Header().Set("Cache-Control", "public, max-age=300")
	}
}
