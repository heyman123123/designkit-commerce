package storage

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func fixedS3(endpoint string) *S3 {
	fixed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return &S3{
		Endpoint: endpoint, Region: "auto", Bucket: "dk-bucket",
		AccessKey: "AKIATEST", SecretKey: "secret-test",
		PathStyle: true,
		Now:       func() time.Time { return fixed },
	}
}

func TestPresignDeterministic(t *testing.T) {
	s := fixedS3("https://s3.example.com")
	u1, err := s.PresignGet("ws/1/a.png", 15*time.Minute)
	if err != nil {
		t.Fatalf("presign get: %v", err)
	}
	u2, _ := s.PresignGet("ws/1/a.png", 15*time.Minute)
	if u1 != u2 {
		t.Fatalf("presign should be deterministic:\n%s\n%s", u1, u2)
	}
	for _, want := range []string{
		"X-Amz-Algorithm=AWS4-HMAC-SHA256",
		"X-Amz-Credential=AKIATEST%2F20260101%2Fauto%2Fs3%2Faws4_request",
		"X-Amz-Date=20260101T000000Z",
		"X-Amz-Expires=900",
		"X-Amz-SignedHeaders=host",
		"X-Amz-Signature=",
	} {
		if !strings.Contains(u1, want) {
			t.Fatalf("missing %q in %s", want, u1)
		}
	}
	if !strings.HasPrefix(u1, "https://s3.example.com/dk-bucket/ws/1/a.png?") {
		t.Fatalf("unexpected object url: %s", u1)
	}
}

func TestPresignPutDiffersFromGet(t *testing.T) {
	s := fixedS3("https://s3.example.com")
	getURL, _ := s.PresignGet("k.png", time.Minute)
	putURL, _ := s.PresignPut("k.png", time.Minute)
	g := getURL[strings.Index(getURL, "X-Amz-Signature="):]
	p := putURL[strings.Index(putURL, "X-Amz-Signature="):]
	if g == p {
		t.Fatalf("GET and PUT signatures must differ")
	}
}

func TestS3SaveAndOpen(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotSHA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotSHA = r.Header.Get("x-amz-content-sha256")
		if r.Method == http.MethodGet {
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "hello")
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	s := fixedS3(srv.URL)
	n, err := s.Save(context.Background(), "ws/1/a.png", strings.NewReader("hello"))
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	_ = n
	if gotMethod != http.MethodPut {
		t.Fatalf("save method = %s", gotMethod)
	}
	if gotPath != "/dk-bucket/ws/1/a.png" {
		t.Fatalf("save path = %s", gotPath)
	}
	if !strings.HasPrefix(gotAuth, "AWS4-HMAC-SHA256 Credential=AKIATEST/20260101/auto/s3/aws4_request") {
		t.Fatalf("bad authorization: %s", gotAuth)
	}
	if gotSHA != unsignedPayload {
		t.Fatalf("content sha = %s", gotSHA)
	}

	rc, err := s.Open(context.Background(), "ws/1/a.png")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer rc.Close()
	b, _ := io.ReadAll(rc)
	if string(b) != "hello" {
		t.Fatalf("open body = %q", b)
	}
	if gotMethod != http.MethodGet {
		t.Fatalf("open method = %s", gotMethod)
	}
}

func TestS3RejectsBadKey(t *testing.T) {
	s := fixedS3("https://s3.example.com")
	for _, k := range []string{"", "/abs", "../escape"} {
		if _, err := s.PresignGet(k, time.Minute); err == nil {
			t.Fatalf("key %q should be rejected", k)
		}
	}
}
