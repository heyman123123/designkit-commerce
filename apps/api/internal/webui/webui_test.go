package webui

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
)

// TestMountRedirectsAndSPA 校验三入口尾部斜杠跳转与 SPA 回退。
func TestMountRedirectsAndSPA(t *testing.T) {
	web := t.TempDir()
	mobile := t.TempDir()
	for _, dir := range []struct{ path, body string }{
		{filepath.Join(web, "app", "index.html"), "<html>app</html>"},
		{filepath.Join(web, "admin", "index.html"), "<html>admin</html>"},
		{filepath.Join(mobile, "index.html"), "<html>mobile</html>"},
	} {
		if err := os.MkdirAll(filepath.Dir(dir.path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(dir.path, []byte(dir.body), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	r := chi.NewRouter()
	Mount(r, web, mobile)
	srv := httptest.NewServer(r)
	defer srv.Close()

	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, prefix := range []string{"/app", "/admin", "/m"} {
		res, err := client.Get(srv.URL + prefix)
		if err != nil {
			t.Fatalf("get %s: %v", prefix, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusFound || res.Header.Get("Location") != prefix+"/" {
			t.Fatalf("%s -> %d %q, want 302 %s/", prefix, res.StatusCode, res.Header.Get("Location"), prefix)
		}
	}
	// hash 路由未命中也要回退到 index.html。
	res, err := http.Get(srv.URL + "/m/job/abc")
	if err != nil {
		t.Fatalf("spa: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("spa fallback = %d", res.StatusCode)
	}
}
