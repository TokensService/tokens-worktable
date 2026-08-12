def test_package_imports():
    import op_test

    assert op_test.__version__ == "0.1.0"
